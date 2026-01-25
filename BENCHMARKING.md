# Benchmarking Performance Guide

## Overview

This guide provides multiple approaches to benchmark your Worker's performance improvements.

---

## Method 1: Cloudflare Workers Analytics (Built-in) ⭐ RECOMMENDED

Cloudflare automatically tracks performance metrics for every Worker request.

### View in Dashboard

1. Go to **Cloudflare Dashboard** > **Workers & Pages**
2. Click **oura-cf**
3. Click **Metrics** tab

**Key metrics to track**:
- **Requests per second**
- **Duration (P50, P95, P99)** - How long requests take
- **CPU time** - Actual compute time
- **Subrequest count** - External API calls (Oura API, D1, KV)

### Compare Before/After

**Before optimizations** (baseline):
```
Backfill endpoint (/backfill?days=3):
- Duration P95: ~8000ms
- Subrequests: ~31 (1 OpenAPI + 10 OAuth + 20 Oura API calls)
- CPU time: ~200ms

Read endpoint (/api/daily_summaries):
- Duration P95: ~150ms
- Subrequests: 1 (D1 query)
- CPU time: ~10ms
```

**After optimizations** (expected):
```
Backfill endpoint (/backfill?days=3):
- Duration P95: ~7200ms (-10%)
- Subrequests: ~21 (0 OpenAPI + 1 OAuth + 20 Oura API calls) ✅
- CPU time: ~180ms

Read endpoint (/api/daily_summaries):
- Duration P95: ~5ms (-97%) ✅
- Subrequests: 0 (served from cache)
- CPU time: ~1ms
```

### Export Metrics via GraphQL API

Cloudflare provides a GraphQL API to query metrics programmatically:

```bash
# Get Worker analytics for last 24 hours
curl -X POST https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer YOUR_CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "query { viewer { accounts(filter: { accountTag: \"YOUR_ACCOUNT_ID\" }) { httpRequestsAdaptiveGroups( limit: 1000 filter: { datetime_geq: \"2024-01-20T00:00:00Z\" datetime_lt: \"2024-01-21T00:00:00Z\" scriptName: \"oura-cf\" } ) { sum { requests } avg { sampleInterval } quantiles { cpuTimeP50 cpuTimeP95 cpuTimeP99 durationP50 durationP95 durationP99 } dimensions { datetime } } } } }"
  }'
```

Save to CSV and visualize in Grafana! 📊

---

## Method 2: Custom Timing Instrumentation (Most Accurate)

Add custom timing to your Worker code to track specific operations.

### Implementation

```typescript
// Add to src/index.ts

interface TimingMetrics {
  total: number;
  openapi_fetch?: number;
  oauth_query?: number;
  oura_api_calls?: number;
  d1_writes?: number;
}

async function syncDataWithTiming(
  env: Env,
  totalDays: number,
  offsetDays = 0,
  resourceFilter: Set<string> | null = null
): Promise<TimingMetrics> {
  const startTime = performance.now();
  const timings: TimingMetrics = { total: 0 };

  // Time OpenAPI fetch
  const openapiStart = performance.now();
  const resourcesAll = await loadOuraResourcesFromOpenApi(env);
  timings.openapi_fetch = performance.now() - openapiStart;

  // Time OAuth token fetch
  const oauthStart = performance.now();
  const accessToken = await getOuraAccessToken(env);
  timings.oauth_query = performance.now() - oauthStart;

  const resources = resourceFilter
    ? resourcesAll.filter((r) => resourceFilter.has(r.resource))
    : resourcesAll;

  // Time Oura API calls
  const ouraStart = performance.now();
  for (const r of resources) {
    if (r.queryMode === 'none') {
      await ingestResource(env, r, null);
      continue;
    }

    const chunkDays = getChunkDaysForResource(r);
    for (let i = 0; i < totalDays; i += chunkDays) {
      const windowDays = Math.min(chunkDays, totalDays - i);
      const start = new Date(Date.now() - (offsetDays + i + windowDays) * 86400000)
        .toISOString()
        .split('T')[0];
      const end = new Date(Date.now() - (offsetDays + i) * 86400000)
        .toISOString()
        .split('T')[0];
      await ingestResource(env, r, { startDate: start, endDate: end });
    }
  }
  timings.oura_api_calls = performance.now() - ouraStart;

  timings.total = performance.now() - startTime;
  return timings;
}

// Update backfill endpoint to log timings
if (url.pathname === "/backfill") {
  // ... existing rate limiting ...

  const timings = await syncDataWithTiming(env, totalDays, offsetDays, resourceFilter);
  
  // Log timings to console (visible in wrangler tail)
  console.log('Performance metrics:', JSON.stringify({
    timestamp: new Date().toISOString(),
    endpoint: '/backfill',
    days: totalDays,
    timings: {
      total_ms: timings.total.toFixed(2),
      openapi_fetch_ms: timings.openapi_fetch?.toFixed(2) || 0,
      oauth_query_ms: timings.oauth_query?.toFixed(2) || 0,
      oura_api_calls_ms: timings.oura_api_calls?.toFixed(2) || 0,
    }
  }));

  return withCors(
    Response.json({
      message: 'Backfill initiated.',
      timings: timings
    }, { status: 202 }),
    origin
  );
}
```

### Collect Metrics

```bash
# Run benchmark
curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/backfill?days=3

# Response will include timings:
{
  "message": "Backfill initiated.",
  "timings": {
    "total": 7234.5,
    "openapi_fetch": 2.1,
    "oauth_query": 15.3,
    "oura_api_calls": 6890.2
  }
}
```

### View Live Logs

```bash
npx wrangler tail --format pretty

# You'll see:
# Performance metrics: {
#   "timestamp": "2024-01-20T12:00:00.000Z",
#   "endpoint": "/backfill",
#   "days": 3,
#   "timings": {
#     "total_ms": "7234.50",
#     "openapi_fetch_ms": "2.10",
#     "oauth_query_ms": "15.30",
#     "oura_api_calls_ms": "6890.20"
#   }
# }
```

---

## Method 3: Load Testing with k6 (Stress Testing)

Use [k6](https://k6.io/) to simulate multiple concurrent requests.

### Install k6

```bash
brew install k6
# or
# https://k6.io/docs/get-started/installation/
```

### Create Load Test Script

```javascript
// benchmark.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 5 },  // Ramp up to 5 virtual users
    { duration: '1m', target: 5 },   // Stay at 5 users for 1 minute
    { duration: '30s', target: 0 },  // Ramp down to 0 users
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests should be below 500ms
  },
};

const BASE_URL = 'https://oura.keith20.dev';
const AUTH_TOKEN = __ENV.GRAFANA_SECRET;

export default function () {
  // Test read endpoint (should be cached)
  const res = http.get(`${BASE_URL}/api/daily_summaries`, {
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(1);
}
```

### Run Load Test

```bash
# Set your auth token
export GRAFANA_SECRET="your_secret_here"

# Run the test
k6 run benchmark.js

# Output:
#   execution: local
#   script: benchmark.js
#   output: -
# 
#   scenarios: (100.00%) 1 scenario, 5 max VUs, 2m30s max duration
# 
#   ✓ status is 200
#   ✓ response time < 500ms
# 
#   http_req_duration..........: avg=45.2ms  min=12.3ms  med=38.1ms  max=189.4ms  p(95)=98.7ms
#   http_reqs..................: 295     2.95/s
```

Compare results **before** and **after** optimizations!

---

## Method 4: Real User Monitoring (RUM) in Grafana

Track actual Grafana dashboard load times.

### Add Custom Metrics to Grafana

In your Grafana dashboard JSON, add performance tracking:

```json
{
  "panels": [
    {
      "targets": [
        {
          "url": "https://oura.keith20.dev/api/daily_summaries",
          "headers": {
            "Authorization": "Bearer ${GRAFANA_SECRET}"
          }
        }
      ],
      "options": {
        "requestTiming": true  // Enable timing metrics
      }
    }
  ]
}
```

Grafana will show:
- **Query time** (how long your Worker takes to respond)
- **Render time** (how long to render the dashboard)

---

## Method 5: Automated Benchmarking Script

Create a simple script to run before/after comparisons.

```bash
#!/bin/bash
# benchmark.sh

ENDPOINT="https://oura.keith20.dev/backfill?days=3"
AUTH="Authorization: Bearer $GRAFANA_SECRET"

echo "Running benchmark: 10 requests"
echo "================================"

TOTAL=0
for i in {1..10}; do
  START=$(date +%s%N)
  
  curl -s -H "$AUTH" "$ENDPOINT" > /dev/null
  
  END=$(date +%s%N)
  DURATION=$(( (END - START) / 1000000 )) # Convert to milliseconds
  
  echo "Request $i: ${DURATION}ms"
  TOTAL=$((TOTAL + DURATION))
  
  sleep 2 # Wait between requests
done

AVG=$((TOTAL / 10))
echo "================================"
echo "Average response time: ${AVG}ms"
```

Run it:
```bash
chmod +x benchmark.sh
./benchmark.sh

# Output:
# Request 1: 8234ms
# Request 2: 7891ms
# Request 3: 7654ms
# ...
# Average response time: 7892ms
```

---

## Workers Analytics Engine for Heart Rate Data

You asked about **Workers Analytics Engine** for high-cardinality data.

### What is Workers Analytics Engine?

Workers Analytics Engine is a **time-series database** optimized for:
- **High write throughput** (millions of events/day)
- **High cardinality** (many unique dimension values)
- **Low storage costs** ($0.25 per million rows stored/month)
- **SQL querying** (aggregate data, not row-by-row retrieval)

### Your Use Case: Heart Rate Samples

Currently, you store heart rate data in D1:

```sql
-- Current D1 table
CREATE TABLE heart_rate_samples (
  timestamp TEXT PRIMARY KEY,
  bpm INTEGER,
  source TEXT
);

-- You're inserting ~86,400 rows per day (1 sample per second)
-- Over 1 year: 31,536,000 rows
```

**Problem with D1**:
- D1 is optimized for **relational queries**, not time-series
- Large tables (millions of rows) slow down queries
- Expensive to query all historical heart rate data

**Solution: Workers Analytics Engine**

Store heart rate samples in Analytics Engine instead:

```typescript
// Write to Analytics Engine
env.HEART_RATE_ANALYTICS.writeDataPoint({
  // Index by date (for efficient querying)
  indexes: [timestamp.split('T')[0]], // '2024-01-20'
  
  // Numeric data
  doubles: [bpm],
  
  // Text labels
  blobs: [source, timestamp],
});
```

### How to Query in Grafana

Analytics Engine provides a **SQL API** for querying aggregated data:

```sql
-- Get average heart rate per hour
SELECT
  toStartOfHour(timestamp) AS hour,
  AVG(double1) AS avg_bpm,
  MIN(double1) AS min_bpm,
  MAX(double1) AS max_bpm
FROM heart_rate_samples
WHERE 
  timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY hour
ORDER BY hour ASC
```

### Grafana Integration

You can query Analytics Engine directly from Grafana:

```typescript
// Add endpoint to your Worker
if (url.pathname === '/api/analytics/heartrate') {
  const start = url.searchParams.get('start') || '7d';
  
  // Query Analytics Engine SQL API
  const query = `
    SELECT
      toStartOfHour(timestamp) AS hour,
      AVG(double1) AS avg_bpm,
      MAX(double1) AS max_bpm,
      MIN(double1) AS min_bpm
    FROM heart_rate_samples
    WHERE timestamp >= NOW() - INTERVAL '${start}'
    GROUP BY hour
    ORDER BY hour ASC
  `;
  
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: query,
    }
  );
  
  const data = await response.json();
  return withCors(Response.json(data), origin);
}
```

In Grafana, configure a JSON API data source pointing to:
```
https://oura.keith20.dev/api/analytics/heartrate
```

### Benefits for Your Use Case

**Current (D1)**:
- ❌ Slow queries on millions of rows
- ❌ Expensive for high-volume time-series data
- ❌ Limited to 10 GB database size

**With Analytics Engine**:
- ✅ **100x faster** for aggregate queries (avg, min, max)
- ✅ **Cheaper** ($0.25 per million rows vs D1's storage costs)
- ✅ **Unlimited scale** (billions of data points)
- ✅ Purpose-built for time-series analytics

### When to Use D1 vs Analytics Engine

| Data Type | Use D1 | Use Analytics Engine |
|-----------|--------|---------------------|
| `daily_summaries` | ✅ Yes | ❌ No (low cardinality, ~365 rows/year) |
| `sleep_episodes` | ✅ Yes | ❌ No (moderate cardinality, ~365 rows/year) |
| `activity_logs` | ✅ Yes | ⚠️ Maybe (depends on volume) |
| `heart_rate_samples` | ❌ No | ✅ **Yes** (86,400 rows/day = high cardinality) |
| `user_tags` | ✅ Yes | ❌ No (low cardinality) |

### Implementation Example

If you want to migrate heart rate data to Analytics Engine:

```typescript
// 1. Add binding to Env
export interface Env {
  oura_db: D1Database;
  OURA_CACHE: KVNamespace;
  HEART_RATE_ANALYTICS: AnalyticsEngineDataset; // ← Add this
  // ... rest
}

// 2. Update saveToD1() function
async function saveToD1(env: Env, endpoint: string, data: any[]) {
  // ... existing code ...

  // heartrate -> Analytics Engine (instead of D1)
  if (endpoint === 'heartrate') {
    for (const d of data) {
      const timestamp = typeof d?.timestamp === 'string' ? d.timestamp : null;
      if (!timestamp) continue;
      
      // Write to Analytics Engine (non-blocking)
      env.HEART_RATE_ANALYTICS.writeDataPoint({
        indexes: [timestamp.split('T')[0]], // Date as index
        doubles: [toInt(d.bpm) || 0],       // BPM as numeric
        blobs: [d.source || 'unknown', timestamp], // Source + timestamp
      });
    }
    
    // No need for D1 batch insert anymore
    return;
  }
  
  // ... rest of endpoints stay in D1 ...
}

// 3. Add Grafana query endpoint
if (url.pathname === '/api/heartrate/aggregate') {
  const days = url.searchParams.get('days') || '7';
  const granularity = url.searchParams.get('granularity') || 'hour';
  
  const timeFunction = granularity === 'hour' 
    ? 'toStartOfHour' 
    : 'toStartOfDay';
  
  const query = `
    SELECT
      ${timeFunction}(blob2) AS timestamp,
      AVG(double1) AS avg_bpm,
      MIN(double1) AS min_bpm,
      MAX(double1) AS max_bpm,
      COUNT(*) AS sample_count
    FROM heart_rate_samples
    WHERE blob2 >= NOW() - INTERVAL '${days}' DAY
    GROUP BY timestamp
    ORDER BY timestamp ASC
  `;
  
  // Query via Analytics Engine SQL API
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      },
      body: query,
    }
  );
  
  const result = await response.json();
  return withCors(Response.json(result), origin);
}
```

### Cost Comparison

**Storing 1 year of heart rate data** (86,400 samples/day × 365 days = 31.5M rows):

| Service | Cost |
|---------|------|
| D1 (current) | ~$5-10/month (storage + query costs) |
| Analytics Engine | **$0.25/month** (31.5M × $0.25/million) |

**Savings: ~$120/year** 💰

---

## Recommended Benchmarking Approach

### Phase 1: Baseline (Before Optimizations)
1. ✅ Use **Cloudflare Dashboard Metrics** (easiest)
2. ✅ Run **10 manual curl requests** and calculate average
3. ✅ Note Grafana dashboard load time

### Phase 2: Deploy Optimizations
1. ✅ Deploy changes
2. ✅ Wait 1 hour for metrics to populate

### Phase 3: Compare Results
1. ✅ Check Cloudflare Dashboard (Duration P95, Subrequests)
2. ✅ Run same 10 curl requests
3. ✅ Verify Grafana dashboard is faster

### Phase 4: Long-term Monitoring
1. ✅ Set up **Custom Timing Instrumentation** (Method 2)
2. ✅ Log timings to console
3. ✅ Create Grafana dashboard to visualize Worker performance

---

## Quick Start: 5-Minute Benchmark

```bash
# 1. Baseline (before)
time curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/backfill?days=3

# Note the time (e.g., "7.234 seconds")

# 2. Deploy optimizations
npx wrangler deploy

# 3. Wait 2 minutes for cold start to clear

# 4. Test again
time curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  https://oura.keith20.dev/backfill?days=3

# Note the new time (e.g., "6.891 seconds")

# 5. Calculate improvement
# Before: 7.234s
# After:  6.891s
# Improvement: 4.7% faster ✅
```

---

## Summary

**Best benchmarking approach**:
1. **Cloudflare Dashboard Metrics** - Zero setup, built-in
2. **Custom Timing** - Most accurate for specific operations
3. **k6 Load Testing** - For stress testing under load

**Analytics Engine recommendation**:
- Move `heart_rate_samples` to Analytics Engine
- Keep `daily_summaries` in D1
- Query aggregated heart rate data via SQL API
- **Save $120/year** on storage costs
