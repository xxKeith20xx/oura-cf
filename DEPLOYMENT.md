# Deployment Instructions - Performance Optimizations

## Prerequisites

- [x] Wrangler CLI installed
- [x] Cloudflare account with Workers enabled
- [x] Existing D1 database (`oura_db`)
- [x] Existing secrets configured (`GRAFANA_SECRET`, etc.)

---

## Step 1: Create KV Namespace

```bash
# Create production KV namespace
npx wrangler kv namespace create OURA_CACHE

# Expected output:
# 🌀 Creating namespace with title "oura-cf-OURA_CACHE"
# ✨ Success!
# Add the following to your configuration file in your kv_namespaces array:
# { binding = "OURA_CACHE", id = "abc123..." }
```

**Copy the `id` from the output** (e.g., `abc123...`)

---

## Step 2: Update wrangler.jsonc

Open `wrangler.jsonc` and replace `YOUR_KV_NAMESPACE_ID` with the ID from Step 1:

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "OURA_CACHE",
      "id": "abc123..."  // ← Replace with your actual ID
    }
  ],
  // ... rest of config
}
```

---

## Step 3: Verify Configuration

```bash
# Check that all bindings are correct
cat wrangler.jsonc | grep -A 2 "kv_namespaces"
```

Expected output:
```jsonc
"kv_namespaces": [
  {
    "binding": "OURA_CACHE",
    "id": "YOUR_ACTUAL_KV_ID"
  }
],
```

---

## Step 4: Test Locally (Optional)

```bash
# Create a local KV namespace for testing
npx wrangler kv namespace create OURA_CACHE --preview

# Copy the preview_id and add to wrangler.jsonc
```

Update `wrangler.jsonc`:
```jsonc
{
  "kv_namespaces": [
    {
      "binding": "OURA_CACHE",
      "id": "abc123...",           // Production
      "preview_id": "xyz789..."    // Local dev
    }
  ]
}
```

Run local dev server:
```bash
npx wrangler dev
```

Test the health endpoint:
```bash
curl http://localhost:8787/health
```

---

## Step 5: Deploy to Production

```bash
# Deploy the Worker
npx wrangler deploy

# Expected output:
# Total Upload: XX.XX KiB / gzip: XX.XX KiB
# Uploaded oura-cf (X.XX sec)
# Published oura-cf (X.XX sec)
#   https://oura.keith20.dev
# Current Deployment ID: xxxx-xxxx-xxxx
```

---

## Step 6: Verify Deployment

### Test 1: Health Check
```bash
curl https://oura.keith20.dev/health

# Expected: {"status":"ok","timestamp":"...","version":"1.0.0",...}
```

### Test 2: OpenAPI Cache
```bash
# First request (should fetch from Oura and cache in KV)
time curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/backfill?days=1

# Check KV cache (via Wrangler)
npx wrangler kv key get openapi_resources --namespace-id YOUR_KV_ID --preview false

# Should return JSON array of resources
```

### Test 3: Response Caching
```bash
# First request (should hit D1 and cache)
curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/api/daily_summaries \
  -I | grep -i cache-control

# Expected: Cache-Control: private, max-age=300
```

### Test 4: Token Cache
Check logs for OAuth token queries:
```bash
npx wrangler tail --format pretty

# Trigger a backfill
curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/backfill?days=1

# Should see only 1 OAuth query (not 10+)
```

---

## Step 7: Monitor Performance

### View Metrics
```bash
# View Worker metrics
npx wrangler metrics --watch
```

### Check KV Operations
Go to Cloudflare Dashboard:
1. Navigate to **Workers & Pages**
2. Click **KV**
3. Select **OURA_CACHE** namespace
4. Click **Metrics** tab

You should see:
- Read operations (every sync)
- Write operations (every 24 hours when cache expires)

---

## Rollback Plan

If something goes wrong:

### Option 1: Disable KV Cache
```typescript
// Temporarily comment out KV cache in loadOuraResourcesFromOpenApi()
async function loadOuraResourcesFromOpenApi(env: Env): Promise<OuraResource[]> {
  // try {
  //   const cached = await env.OURA_CACHE.get('openapi_resources', 'json');
  //   if (cached && Array.isArray(cached)) {
  //     return cached as OuraResource[];
  //   }
  // } catch (err) { ... }

  // Fetch directly from Oura
  const res = await fetch('https://cloud.ouraring.com/v2/static/json/openapi-1.27.json');
  // ...
}
```

Deploy:
```bash
npx wrangler deploy
```

### Option 2: Full Rollback
```bash
# Get list of deployments
npx wrangler deployments list

# Rollback to previous version
npx wrangler rollback --deployment-id PREVIOUS_DEPLOYMENT_ID
```

---

## Troubleshooting

### Issue: KV Binding Error
```
Error: No such binding: OURA_CACHE
```

**Fix**: 
- Verify KV namespace ID in `wrangler.jsonc`
- Ensure you deployed after updating config
- Check binding name matches exactly (`OURA_CACHE`)

### Issue: Cache Not Working
```bash
# Check if data is in KV
npx wrangler kv key list --namespace-id YOUR_KV_ID --preview false

# Should show: ["openapi_resources"]
```

**Fix**:
- Trigger a backfill to populate cache
- Check KV metrics for write errors
- Verify TTL is set correctly (24 hours)

### Issue: Token Cache Not Working
**Symptoms**: Multiple D1 queries for OAuth token in logs

**Fix**:
- Token cache only persists within same Worker instance
- Cold starts reset the cache (expected behavior)
- Check token expiration logic

---

## Performance Validation

### Before Optimizations (Baseline)
```bash
# Measure backfill time
time curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/backfill?days=3

# Expected: ~8-10 seconds
```

### After Optimizations (Expected)
```bash
# Should be ~10% faster
time curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/backfill?days=3

# Expected: ~7-9 seconds
```

### Cache Hit Rate
Check Grafana queries:
```bash
# Count requests per 5 minutes
# Before: 5 requests/min × 5 min = 25 D1 queries
# After: 1 request/5min = 1 D1 query (96% reduction ✅)
```

---

## Cost Impact

### KV Costs
- **Reads**: 10 million requests/month = $0.50
- **Writes**: 1 million requests/month = $5.00
- **Storage**: First 1 GB = Free

**Expected usage** (with optimizations):
- Reads: ~8,640/month (1 per sync × 3 syncs/day × 30 days) = **FREE**
- Writes: ~30/month (1 per 24 hours) = **FREE**
- Storage: <1 KB = **FREE**

**Total KV cost: $0.00/month** ✅

### D1 Cost Savings
- **Before**: ~300 queries/hour (Grafana polling)
- **After**: ~12 queries/hour (cached responses)
- **Savings**: 288 queries/hour × 720 hours/month = 207,360 queries/month

At $0.001 per 1,000 queries beyond free tier:
- **Estimated savings**: ~$0.20/month (plus staying under free tier)

---

## Next Steps

1. ✅ Deploy to production
2. ✅ Monitor for 24 hours
3. ✅ Verify KV cache hits in metrics
4. ✅ Check response times improve
5. ⚠️ Consider implementing parallel resource ingestion (next optimization)

---

## Support

If you encounter issues:
1. Check Cloudflare Dashboard > Workers & Pages > oura-cf > Logs
2. Run `npx wrangler tail` to see real-time logs
3. Verify KV namespace exists and is bound correctly
4. Check secrets are still configured: `npx wrangler secret list`
