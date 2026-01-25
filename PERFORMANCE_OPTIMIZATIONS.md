# Performance Optimizations Implemented

## 1. OpenAPI Spec Caching with KV

**Problem**: Previously, the Worker fetched the Oura OpenAPI spec from `cloud.ouraring.com` on every `syncData()` call. The in-memory cache reset on every cold start.

**Solution**: Implemented KV-based caching with 24-hour TTL.

**Changes**:
- Added `OURA_CACHE` KV namespace to Env interface
- Modified `loadOuraResourcesFromOpenApi()` to check KV first before fetching
- Cache parsed resources for 24 hours
- Graceful fallback if KV is unavailable

**Impact**: 
- Eliminates 1 external HTTP request per sync operation
- ~200-500ms saved per sync (depending on OpenAPI spec fetch time)
- Reduced bandwidth and API calls to Oura

---

## 2. Response Caching for Read Endpoints

**Problem**: Grafana dashboards polling `/` and `/api/daily_summaries` hit D1 on every request, even when data hasn't changed.

**Solution**: Added `Cache-Control` headers with 5-minute TTL for read endpoints.

**Changes**:
- Added `RESPONSE_CACHE_TTL` constant (300 seconds)
- Modified `/api/daily_summaries` to include `Cache-Control: public, max-age=300`
- Modified `/` endpoint to include same cache headers

**Impact**:
- ~95% reduction in D1 queries for frequently-polled endpoints
- Faster response times for cached requests (served from Cloudflare edge)
- Reduced D1 usage and costs

**Note**: If you need fresher data, you can:
- Reduce `RESPONSE_CACHE_TTL` to 60 seconds
- Add cache-busting query params (`?v=timestamp`)
- Use `Cache-Control: private` if data is user-specific

---

## 3. In-Memory OAuth Token Caching

**Problem**: Every `syncData()` call queried D1 for the OAuth token, even if it was still valid.

**Solution**: Cache valid tokens in memory (survives within same Worker instance).

**Changes**:
- Added `tokenCache` global variable to store `{ token, expiresAt }`
- Check cache before querying D1
- Cache tokens with 1-minute buffer before expiration
- Cache PATs (Personal Access Tokens) with 24-hour TTL

**Impact**:
- Eliminates 1 D1 query per resource sync operation
- For a 10-resource sync, this saves 10 D1 queries
- Token persists across requests in same Worker instance (until evicted)

---

## Setup Instructions

### 1. Create KV Namespace

```bash
# Create production KV namespace
npx wrangler kv namespace create OURA_CACHE

# You'll get output like:
# 🌀 Creating namespace with title "oura-cf-OURA_CACHE"
# ✨ Success!
# Add the following to your wrangler.jsonc:
# { binding = "OURA_CACHE", id = "abc123..." }
```

### 2. Update wrangler.jsonc

Replace `YOUR_KV_NAMESPACE_ID` in `wrangler.jsonc` with the ID from step 1.

### 3. Deploy

```bash
npx wrangler deploy
```

---

## Why Upserts Instead of Inserts?

**You asked**: "Why would I be doing upserts rather than inserts?"

**Answer**: Your Worker uses **upserts** (INSERT ... ON CONFLICT DO UPDATE) because:

### 1. **Data is Fetched in Overlapping Windows**
Your `syncData()` function fetches data in 90-day (or 29-day for heartrate) chunks. When you:
- Run daily cron jobs (syncing last 3 days)
- Run manual backfills (syncing last 730 days)
- Re-sync data after Oura updates historical values

These windows **overlap**, meaning you'll fetch the same `day` multiple times.

### 2. **Oura Updates Historical Data**
Oura Ring sometimes **retroactively updates** scores and metrics as their algorithms improve. For example:
- Sleep score for 2024-01-20 might be `85` today
- But Oura could update it to `87` tomorrow based on new data

With upserts, you get the **latest values** without duplicates.

### 3. **Primary Key is `day` (not `id`)**
Looking at your `daily_summaries` table, the primary key is `day`. If you try to `INSERT` the same `day` twice, you'd get a constraint violation.

### 4. **Multiple Endpoints Write to Same Row**
This is the **critical reason**: Different Oura API endpoints update **different columns** of the same row:

```sql
-- daily_readiness endpoint updates these columns for day='2024-01-20':
INSERT INTO daily_summaries (day, readiness_score, readiness_activity_balance, ...)

-- daily_sleep endpoint updates DIFFERENT columns for the SAME day:
INSERT INTO daily_summaries (day, sleep_score, sleep_deep_sleep, ...)

-- daily_activity endpoint updates MORE columns for the SAME day:
INSERT INTO daily_summaries (day, activity_score, activity_steps, ...)
```

If you used plain `INSERT`, the second endpoint would fail because `day='2024-01-20'` already exists.

### Could You Use INSERT-only?

**Theoretically yes**, but you'd need to:
1. **Fetch all endpoints in parallel** for each day
2. **Combine** all data into a single INSERT per day
3. **Never re-sync** historical data
4. **Accept stale data** if Oura updates values

This is **much more complex** and **less flexible** than upserts.

---

## Performance Metrics (Expected Improvements)

### Before Optimizations
- **Daily cron sync** (3 days, 10 resources):
  - 1 OpenAPI fetch (~300ms)
  - 10 OAuth token queries (~50ms × 10 = 500ms)
  - 30 Oura API calls (~200ms × 30 = 6000ms)
  - 30 D1 batch writes (~50ms × 30 = 1500ms)
  - **Total: ~8300ms**

- **Grafana dashboard refresh** (5 requests/min):
  - 5 D1 queries/min × 60 min = 300 D1 queries/hour

### After Optimizations
- **Daily cron sync** (3 days, 10 resources):
  - 0 OpenAPI fetch (cached in KV) ✅
  - 1 OAuth token query (cached in memory) ✅
  - 30 Oura API calls (~200ms × 30 = 6000ms)
  - 30 D1 batch writes (~50ms × 30 = 1500ms)
  - **Total: ~7500ms (~10% faster)**

- **Grafana dashboard refresh** (5 requests/min):
  - 1 D1 query/5min × 12 = 12 D1 queries/hour ✅ (**96% reduction**)

### Cold Start Impact
- **Before**: OpenAPI fetch on every cold start (~300ms)
- **After**: KV read on cold start (~5-10ms) ✅

---

## Additional Optimization Opportunities (Not Implemented)

If you want even better performance, consider:

1. **Parallelize Resource Ingestion** (mentioned in original analysis)
   - Process multiple resources concurrently with `Promise.all()`
   - Could reduce sync time by 5-10x

2. **Batch D1 Operations Across Resources**
   - Collect all statements and batch together (D1 supports up to 500 statements/batch)
   - Reduces D1 round trips from ~10 to 1-2

3. **Use Workers Analytics Engine for High-Cardinality Data**
   - Move `heart_rate_samples` to Analytics Engine instead of D1
   - D1 is slower for millions of time-series rows

Let me know if you want me to implement any of these!
