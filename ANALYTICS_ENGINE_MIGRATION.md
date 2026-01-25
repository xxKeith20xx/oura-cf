# Migrating Heart Rate Data to Analytics Engine

## Why Migrate?

Your `heart_rate_samples` table is **high-cardinality time-series data**:
- 86,400 samples per day (1 per second)
- 31.5 million rows per year
- Only queried for aggregates (avg, min, max per hour/day)

**D1 is not optimized for this.** Analytics Engine is.

---

## Cost Comparison

| Metric | D1 (Current) | Analytics Engine |
|--------|--------------|------------------|
| Storage (1 year) | ~$5-10/month | **$0.25/month** |
| Write performance | ~1000 rows/sec | **1M+ rows/sec** |
| Query speed (aggregates) | Slow (millions of rows) | **100x faster** |
| Max scale | 10 GB limit | **Unlimited** |

---

## Implementation Steps

### Step 1: Add Analytics Engine Binding

Update `wrangler.jsonc`:

```jsonc
{
  "name": "oura-cf",
  "analytics_engine_datasets": [
    {
      "binding": "HEART_RATE_ANALYTICS",
      "dataset": "heart_rate_samples"
    }
  ],
  // ... rest of config
}
```

Update `Env` interface in `src/index.ts`:

```typescript
export interface Env {
  oura_db: D1Database;
  RATE_LIMITER: RateLimit;
  OURA_CACHE: KVNamespace;
  HEART_RATE_ANALYTICS: AnalyticsEngineDataset; // ← Add this
  GRAFANA_SECRET: string;
  CF_ACCOUNT_ID: string; // For querying Analytics Engine SQL API
  CF_API_TOKEN: string;  // For querying Analytics Engine SQL API
  // ... rest
}
```

### Step 2: Modify Heart Rate Ingestion

Update the `saveToD1()` function:

```typescript
async function saveToD1(env: Env, endpoint: string, data: any[]) {
  // ... existing code for other endpoints ...

  // heartrate -> Analytics Engine (instead of D1)
  if (endpoint === 'heartrate') {
    // Write to Analytics Engine (non-blocking, very fast)
    for (const d of data) {
      const timestamp = typeof d?.timestamp === 'string' ? d.timestamp : null;
      if (!timestamp) continue;
      
      const bpm = toInt(d.bpm) || 0;
      const source = d.source || 'unknown';
      
      // Write data point
      env.HEART_RATE_ANALYTICS.writeDataPoint({
        // Index by date (YYYY-MM-DD) for efficient querying
        indexes: [timestamp.split('T')[0]],
        
        // Store BPM as numeric value
        doubles: [bpm],
        
        // Store source and full timestamp as text
        blobs: [source, timestamp],
      });
    }
    
    // Optional: Keep writing to D1 during migration for backup
    // Comment out after confirming Analytics Engine works
    /*
    const stmt = env.oura_db.prepare(
      'INSERT INTO heart_rate_samples (timestamp, bpm, source) VALUES (?, ?, ?) ' +
      'ON CONFLICT(timestamp) DO UPDATE SET bpm=excluded.bpm, source=excluded.source'
    );
    const stmts = data
      .map((d) => {
        const timestamp = typeof d?.timestamp === 'string' ? d.timestamp : null;
        if (!timestamp) return null;
        return stmt.bind(timestamp, toInt(d.bpm), d.source ?? null);
      })
      .filter(Boolean) as any[];
    if (stmts.length) await env.oura_db.batch(stmts);
    */
    
    return;
  }

  // ... rest of endpoints stay in D1 ...
}
```

### Step 3: Create Grafana Query Endpoint

Add a new endpoint to query heart rate aggregates:

```typescript
// Add to fetch handler in src/index.ts

if (url.pathname === '/api/heartrate/aggregate') {
  // Validate auth
  if (auth !== `Bearer ${env.GRAFANA_SECRET}`) {
    return withCors(new Response('Unauthorized', { status: 401 }), origin);
  }

  const days = url.searchParams.get('days') || '7';
  const granularity = url.searchParams.get('granularity') || 'hour'; // 'hour' or 'day'
  
  // Validate inputs
  const daysNum = parseInt(days, 10);
  if (!Number.isFinite(daysNum) || daysNum < 1 || daysNum > 365) {
    return withCors(
      Response.json({ error: 'days must be between 1 and 365' }, { status: 400 }),
      origin
    );
  }
  
  if (!['hour', 'day'].includes(granularity)) {
    return withCors(
      Response.json({ error: 'granularity must be "hour" or "day"' }, { status: 400 }),
      origin
    );
  }

  // Build SQL query for Analytics Engine
  const timeFunction = granularity === 'hour' ? 'toStartOfHour' : 'toStartOfDay';
  
  const query = `
    SELECT
      ${timeFunction}(parseDateTimeBestEffort(blob2)) AS timestamp,
      AVG(double1) AS avg_bpm,
      MIN(double1) AS min_bpm,
      MAX(double1) AS max_bpm,
      COUNT(*) AS sample_count
    FROM heart_rate_samples
    WHERE blob2 >= formatDateTime(NOW() - INTERVAL ${daysNum} DAY, '%Y-%m-%dT%H:%i:%sZ')
    GROUP BY timestamp
    ORDER BY timestamp ASC
  `;

  try {
    // Query Analytics Engine SQL API
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'text/plain',
        },
        body: query,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Analytics Engine query failed', {
        status: response.status,
        error: errorText.slice(0, 500),
      });
      return withCors(
        Response.json({ error: 'Failed to query Analytics Engine' }, { status: 500 }),
        origin
      );
    }

    const result = await response.json();
    
    // Return results with cache header
    return withCors(
      new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `private, max-age=${RESPONSE_CACHE_TTL}`,
        },
      }),
      origin
    );
  } catch (err) {
    console.error('Analytics Engine error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return withCors(
      Response.json({ error: 'Internal server error' }, { status: 500 }),
      origin
    );
  }
}
```

### Step 4: Configure Secrets

```bash
# Set Cloudflare API credentials
wrangler secret put CF_ACCOUNT_ID
# Enter your account ID (found in Cloudflare Dashboard URL)

wrangler secret put CF_API_TOKEN
# Create an API token with "Analytics Engine" permissions
# https://dash.cloudflare.com/profile/api-tokens
```

### Step 5: Deploy

```bash
npx wrangler deploy
```

---

## Grafana Configuration

### Option 1: JSON API Data Source (Recommended)

1. In Grafana, go to **Configuration** > **Data Sources**
2. Click **Add data source** > **JSON API**
3. Configure:
   - **URL**: `https://oura.keith20.dev/api/heartrate/aggregate`
   - **Custom HTTP Headers**:
     - Header: `Authorization`
     - Value: `Bearer ${GRAFANA_SECRET}`

4. Create a new dashboard panel:

```json
{
  "targets": [
    {
      "url": "https://oura.keith20.dev/api/heartrate/aggregate?days=7&granularity=hour",
      "format": "table"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "mappings": [
        {
          "type": "field",
          "field": "timestamp",
          "format": "time"
        },
        {
          "type": "field", 
          "field": "avg_bpm",
          "displayName": "Average BPM"
        },
        {
          "type": "field",
          "field": "min_bpm", 
          "displayName": "Min BPM"
        },
        {
          "type": "field",
          "field": "max_bpm",
          "displayName": "Max BPM"
        }
      ]
    }
  }
}
```

### Option 2: Transform Analytics Engine Response

If Analytics Engine returns data in a different format, add a transformation endpoint:

```typescript
if (url.pathname === '/api/heartrate/grafana') {
  // ... same auth and query logic ...
  
  const result = await response.json();
  
  // Transform to Grafana time series format
  const grafanaFormat = {
    target: 'Heart Rate',
    datapoints: result.data.map((row: any) => [
      row.avg_bpm,              // value
      new Date(row.timestamp).getTime() // timestamp in ms
    ])
  };
  
  return withCors(Response.json([grafanaFormat]), origin);
}
```

---

## Query Examples

### Get hourly averages for last 7 days

```bash
curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  "https://oura.keith20.dev/api/heartrate/aggregate?days=7&granularity=hour"
```

Response:
```json
{
  "data": [
    {
      "timestamp": "2024-01-20 00:00:00",
      "avg_bpm": 62.5,
      "min_bpm": 58,
      "max_bpm": 68,
      "sample_count": 3600
    },
    {
      "timestamp": "2024-01-20 01:00:00",
      "avg_bpm": 59.2,
      "min_bpm": 55,
      "max_bpm": 64,
      "sample_count": 3600
    }
    // ... more hours
  ]
}
```

### Get daily averages for last 30 days

```bash
curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  "https://oura.keith20.dev/api/heartrate/aggregate?days=30&granularity=day"
```

---

## SQL Query Patterns

Analytics Engine supports standard SQL functions:

### Average BPM by hour of day

```sql
SELECT
  toHour(parseDateTimeBestEffort(blob2)) AS hour_of_day,
  AVG(double1) AS avg_bpm
FROM heart_rate_samples
WHERE blob2 >= formatDateTime(NOW() - INTERVAL 7 DAY, '%Y-%m-%dT%H:%i:%sZ')
GROUP BY hour_of_day
ORDER BY hour_of_day ASC
```

### BPM distribution (histogram)

```sql
SELECT
  floor(double1 / 10) * 10 AS bpm_bucket,
  COUNT(*) AS count
FROM heart_rate_samples
WHERE blob2 >= formatDateTime(NOW() - INTERVAL 7 DAY, '%Y-%m-%dT%H:%i:%sZ')
GROUP BY bpm_bucket
ORDER BY bpm_bucket ASC
```

### Resting heart rate (lowest 10th percentile each day)

```sql
SELECT
  toStartOfDay(parseDateTimeBestEffort(blob2)) AS day,
  quantile(0.1)(double1) AS resting_hr
FROM heart_rate_samples
WHERE blob2 >= formatDateTime(NOW() - INTERVAL 30 DAY, '%Y-%m-%dT%H:%i:%sZ')
GROUP BY day
ORDER BY day ASC
```

---

## Data Migration Strategy

You have existing heart rate data in D1. Here are migration options:

### Option 1: Parallel Write (Recommended)

1. **Enable Analytics Engine writes** (Step 2 above)
2. **Keep D1 writes active** (uncomment the D1 code in `saveToD1()`)
3. **Wait 30 days** for Analytics Engine to collect data
4. **Compare results** between D1 and Analytics Engine
5. **Disable D1 writes** once confident

This gives you a rollback option.

### Option 2: Backfill Historical Data

Export from D1 and write to Analytics Engine:

```typescript
// One-time migration endpoint
if (url.pathname === '/migrate/heartrate') {
  if (auth !== `Bearer ${env.GRAFANA_SECRET}`) {
    return withCors(new Response('Unauthorized', { status: 401 }), origin);
  }

  const limit = 100000; // Process in batches
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  // Read from D1
  const { results } = await env.oura_db
    .prepare('SELECT timestamp, bpm, source FROM heart_rate_samples ORDER BY timestamp LIMIT ? OFFSET ?')
    .bind(limit, offset)
    .all();

  // Write to Analytics Engine
  for (const row of results) {
    env.HEART_RATE_ANALYTICS.writeDataPoint({
      indexes: [row.timestamp.split('T')[0]],
      doubles: [row.bpm || 0],
      blobs: [row.source || 'unknown', row.timestamp],
    });
  }

  return withCors(
    Response.json({
      migrated: results.length,
      next_offset: offset + limit,
      total_processed: offset + results.length
    }),
    origin
  );
}
```

Run migration:
```bash
# Migrate in batches of 100k rows
curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  "https://oura.keith20.dev/migrate/heartrate?offset=0"

curl -H "Authorization: Bearer $GRAFANA_SECRET" \
  "https://oura.keith20.dev/migrate/heartrate?offset=100000"

# Continue until all data migrated
```

### Option 3: Fresh Start

Just start writing to Analytics Engine and let old D1 data age out:
- Keep D1 table for historical queries (read-only)
- All new data goes to Analytics Engine
- Eventually drop D1 table after 1 year

---

## Monitoring

Check Analytics Engine usage in Cloudflare Dashboard:
1. Go to **Analytics & Logs** > **Workers Analytics Engine**
2. Select **heart_rate_samples** dataset
3. View:
   - Rows written per day
   - Query count
   - Storage used

---

## Rollback Plan

If something goes wrong:

1. **Keep D1 writes active** during transition
2. **Compare results** between D1 and Analytics Engine
3. **Revert Grafana queries** to use D1 instead:

```typescript
// Rollback endpoint using D1
if (url.pathname === '/api/heartrate/aggregate') {
  const days = url.searchParams.get('days') || '7';
  const granularity = url.searchParams.get('granularity') || 'hour';
  
  // Query D1 instead
  const { results } = await env.oura_db
    .prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', timestamp) AS timestamp,
        AVG(bpm) AS avg_bpm,
        MIN(bpm) AS min_bpm,
        MAX(bpm) AS max_bpm,
        COUNT(*) AS sample_count
      FROM heart_rate_samples
      WHERE timestamp >= datetime('now', '-${days} days')
      GROUP BY strftime('%Y-%m-%d %H:00:00', timestamp)
      ORDER BY timestamp ASC
    `)
    .all();
  
  return withCors(Response.json({ data: results }), origin);
}
```

---

## Performance Comparison

### D1 (Current)

```sql
-- Query 1 week of hourly averages
-- 168 hours × ~3,600 samples = ~600,000 rows scanned
-- Time: ~2-5 seconds ❌
SELECT
  strftime('%Y-%m-%d %H:00:00', timestamp) AS hour,
  AVG(bpm) AS avg_bpm
FROM heart_rate_samples
WHERE timestamp >= datetime('now', '-7 days')
GROUP BY hour
ORDER BY hour ASC
```

### Analytics Engine

```sql
-- Same query, pre-aggregated
-- Time: ~50-200ms ✅ (10-100x faster)
SELECT
  toStartOfHour(parseDateTimeBestEffort(blob2)) AS hour,
  AVG(double1) AS avg_bpm
FROM heart_rate_samples
WHERE blob2 >= formatDateTime(NOW() - INTERVAL 7 DAY, '%Y-%m-%dT%H:%i:%sZ')
GROUP BY hour
ORDER BY hour ASC
```

---

## Cost Savings

**Current D1 storage** (1 year):
- 31.5M rows × ~50 bytes/row = **1.5 GB**
- D1 storage: **$0.75/GB/month** = $1.13/month
- D1 reads: **$0.001 per 1,000 rows** 
  - 100 queries/day × 168 hours × 3,600 rows = 60M row reads/day
  - 60M × 30 days = **1.8 billion row reads/month**
  - 1.8B / 1,000 × $0.001 = **$1,800/month** 😱

**Analytics Engine**:
- 31.5M rows × **$0.25 per million** = **$7.88/year** = **$0.66/month**
- Queries: **FREE** (unlimited SQL queries)

**Total savings: ~$1,800/month** 💰💰💰

---

## Summary

**Migrate heart rate data to Analytics Engine if**:
- ✅ You query aggregates (not individual samples)
- ✅ You have millions of rows
- ✅ D1 queries are slow
- ✅ You want to save money

**Keep in D1 if**:
- ❌ You need row-level queries (get exact sample at timestamp)
- ❌ You have < 100k rows
- ❌ You need relational joins with other tables

For your use case: **Analytics Engine is the right choice** ✅
