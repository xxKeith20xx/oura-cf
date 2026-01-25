# Security Review - Performance Optimizations

## Summary

✅ **All changes are secure for your current single-user setup.**

Minor improvements made: Changed `public` to `private` cache control for authenticated endpoints.

---

## Change-by-Change Analysis

### 1. ✅ KV Cache for OpenAPI Spec - SECURE

**What**: Cache Oura's OpenAPI specification in Workers KV

**Security Assessment**: **SAFE**
- OpenAPI spec is public data (no sensitive info)
- Contains only API endpoint metadata
- No user data or credentials involved
- KV namespace is private (only accessible via Worker binding)

**Risk Level**: None

---

### 2. ✅ In-Memory OAuth Token Caching - SECURE (for single-user)

**What**: Cache OAuth tokens in Worker memory to avoid repeated D1 queries

**Security Assessment**: **SAFE for single-user app**

**Why it's safe**:
- Your app uses a single user (`userId = 'default'`)
- Workers provide request isolation within the same isolate
- Token cache is scoped to Worker instance (not shared globally)
- Tokens have proper expiration handling (60-second buffer)

**⚠️ Multi-User Warning**:
If you ever add multiple users, you MUST change this:

```typescript
// CURRENT (single user) - SAFE ✅
let tokenCache: { token: string; expiresAt: number } | null = null;

// FUTURE (multi-user) - NEEDS UPDATE ⚠️
let tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
```

**Risk Level**: None (current implementation)

---

### 3. ✅ Response Caching - SECURE (after fix)

**What**: Add `Cache-Control` headers to read endpoints

**Security Assessment**: **SAFE** (with applied fixes)

**Original Issue**:
- Used `Cache-Control: public` for authenticated endpoints
- Could allow CDNs/proxies to cache sensitive data

**Fix Applied**:
```typescript
// Changed from 'public' to 'private'
'Cache-Control': `private, max-age=${RESPONSE_CACHE_TTL}`
```

**Why this matters**:
- `public` = cached by anyone (CDNs, proxies, shared caches)
- `private` = cached only by end-user's browser
- Since endpoints require `Authorization` header, `private` is correct

**Additional Security Features Already Present**:
- ✅ `Vary: Origin` header prevents cache poisoning
- ✅ Authorization check happens before cached endpoints
- ✅ CORS origin whitelist prevents unauthorized access

**Risk Level**: None (after fix)

---

## Additional Security Considerations

### Rate Limiting ✅
You already have rate limiting on `/backfill`:
```typescript
const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey });
```

**Recommendation**: Consider adding rate limiting to other endpoints:
- `/api/daily_summaries` (prevent query abuse)
- `/api/sql` (prevent database DoS)

---

### SQL Injection Protection ✅

Your `/api/sql` endpoint has good protections:
```typescript
// ✅ Read-only validation
if (!isReadOnlySql(sql)) {
  return withCors(new Response('Only read-only SQL is allowed', { status: 400 }), origin);
}

// ✅ Parameter count limit
if (params.length > 100) { ... }

// ✅ SQL length limit
if (sql.length > MAX_SQL_LENGTH) { ... }

// ✅ Blocks access to OAuth tables
if (/\boura_oauth_tokens\b/i.test(normalized)) return false;
if (/\boura_oauth_states\b/i.test(normalized)) return false;
```

**Additional Recommendation**: Add a whitelist of allowed tables:
```typescript
function isReadOnlySql(sql: string): boolean {
  // ... existing checks ...
  
  // Optional: Whitelist allowed tables
  const allowedTables = [
    'daily_summaries',
    'sleep_episodes', 
    'heart_rate_samples',
    'activity_logs',
    'user_tags',
  ];
  
  // Extract table names and verify against whitelist
  // (implementation left as optional enhancement)
  
  return true;
}
```

---

### CORS Configuration ✅

Your CORS setup is secure:
```typescript
const allowedOrigins = [
  'https://oura.keith20.dev',
  'http://localhost:3000',      // Dev only
  'http://localhost:8787',      // Wrangler dev
];

// Validates origin against whitelist
const allowOrigin = origin && allowedOrigins.includes(origin) 
  ? origin 
  : allowedOrigins[0];

headers.set('Vary', 'Origin'); // ✅ Prevents cache poisoning
```

**Recommendation for production**: Remove localhost origins before deploying:
```typescript
const allowedOrigins = 
  env.ENVIRONMENT === 'production'
    ? ['https://oura.keith20.dev']
    : [
        'https://oura.keith20.dev',
        'http://localhost:3000',
        'http://localhost:8787',
      ];
```

---

### OAuth Token Storage ✅

OAuth tokens are securely stored:
- ✅ Stored in D1 database (encrypted at rest)
- ✅ Not exposed in responses
- ✅ Protected by `isReadOnlySql()` validation
- ✅ Refresh tokens preserved on update (COALESCE logic)

**One concern**: Token expiration calculation:
```typescript
const expiresAt =
  typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
    ? Date.now() + Math.max(0, token.expires_in - 60) * 1000
    : null;
```

This is **correct** - you're subtracting 60 seconds as a safety buffer. ✅

---

## KV Cache Security Checklist

- ✅ KV namespace is private (default behavior)
- ✅ Only accessible via Worker binding (no public API)
- ✅ Data cached is non-sensitive (OpenAPI spec)
- ✅ TTL configured (24 hours)
- ✅ Graceful fallback if KV unavailable

---

## Environment Variables Security

Ensure these secrets are set correctly:

```bash
# ✅ Required secrets (set via Wrangler)
wrangler secret put GRAFANA_SECRET
wrangler secret put OURA_CLIENT_ID
wrangler secret put OURA_CLIENT_SECRET

# ✅ Optional (for Personal Access Token)
wrangler secret put OURA_PAT
```

**Never commit these to Git!** ✅ (already in `.gitignore`)

---

## Recommendations Summary

### Immediate (Applied) ✅
- [x] Change `public` to `private` cache control
- [x] Add security comments to code

### Optional Enhancements
- [ ] Add rate limiting to `/api/daily_summaries` and `/api/sql`
- [ ] Remove localhost CORS origins in production
- [ ] Add table whitelist to SQL validation
- [ ] Add environment-based config (dev vs prod)

### Future (Multi-User) ⚠️
- [ ] Update token cache to use `Map<userId, token>`
- [ ] Add per-user authorization checks
- [ ] Consider row-level security in D1

---

## Testing Security

To verify security improvements:

### 1. Test Cache Headers
```bash
# Should return private cache
curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/api/daily_summaries \
  -I | grep -i cache-control

# Expected: Cache-Control: private, max-age=300
```

### 2. Test CORS
```bash
# Should respect origin whitelist
curl -H "Origin: https://evil.com" \
  https://oura.keith20.dev/api/daily_summaries \
  -I | grep -i access-control

# Expected: Access-Control-Allow-Origin: https://oura.keith20.dev
```

### 3. Test SQL Injection Protection
```bash
# Should reject write operations
curl -X POST https://oura.keith20.dev/api/sql \
  -H "Authorization: Bearer $GRAFANA_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sql":"DROP TABLE daily_summaries"}' 

# Expected: {"error":"Only read-only SQL is allowed"}
```

### 4. Test OAuth Table Protection
```bash
# Should reject queries to oauth tables
curl -X POST https://oura.keith20.dev/api/sql \
  -H "Authorization: Bearer $GRAFANA_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT * FROM oura_oauth_tokens"}' 

# Expected: {"error":"Only read-only SQL is allowed"}
```

---

## Conclusion

**All performance optimizations are secure.** The only change needed was switching from `public` to `private` cache control, which has been applied.

Your Worker follows security best practices:
- ✅ Authentication required for sensitive endpoints
- ✅ CORS properly configured with origin whitelist
- ✅ SQL injection protection
- ✅ OAuth table access blocked
- ✅ Secrets managed via Wrangler (not hardcoded)
- ✅ Rate limiting on backfill endpoint

**No critical security issues identified.**
