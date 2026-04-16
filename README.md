# Oura Ring Data Sync & Analytics Platform

A Cloudflare Worker that syncs Oura Ring health data to a D1 database and serves it to Grafana for visualization and analytics.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)

## Features

- **Complete Data Coverage**: Syncs all Oura Ring v2 API endpoints (18+ resources)
- **Automated Sync**: Every 2 hours via cron, plus webhook-driven near-real-time updates
- **Durable Backfill**: Cloudflare Workflows for reliable, retryable historical data sync
- **Grafana Integration**: Pre-built dashboard JSON included in repo
- **Enterprise Security**: Multi-token auth, timing-safe comparison, 3-tier rate limiting, SQL injection prevention, query timeouts
- **SQL Query Caching**: KV-backed cache with SHA-256 keys, automatic invalidation after sync
- **Analytics Engine**: Query and auth metrics via Cloudflare Analytics Engine
- **Status Page**: `/status` page showing pipeline health, last sync time, and per-table record counts (requires auth)
- **Sync Health Tracking**: Last successful sync metadata written to KV after every cron run
- **Cost-Efficient**: Runs within Cloudflare's free tier limits
- **Test Coverage**: Automated tests covering auth, SQL safety, webhook verification, and queue ingestion
- **Production-Ready**: Comprehensive logging, error handling, observability, and monitoring

## Release Notes (v2.1.0)

- Security hardening: SQL injection via quoted identifiers, error detail leakage, CORS localhost defaults, webhook replay window, OpenAPI domain allowlist, concurrent token refresh dedup, cron overlap protection.
- Performance: incremental heart rate stats, DB growth monitoring (`/api/db/info`), webhook delivery freshness tracking.
- Repo cleanup: removed tutorial docs, stale scripts, and `.gitattributes` binary JSON misconfiguration.
- See [CHANGELOG.md](CHANGELOG.md) for full history.

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Data Model](#data-model)
- [API Endpoints](#api-endpoints)
- [Backfill Workflows](#backfill-workflows)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Cloudflare Access (Recommended)](#cloudflare-access-recommended)
- [Grafana Setup](#grafana-setup)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Roadmap / Next Steps

- [ ] Split `src/index.ts` into route/services/modules to reduce risk and improve maintainability.
- [ ] Introduce a router framework (Hono) for cleaner middleware composition and route ownership.
- [ ] Expand automated coverage for sync engine, OAuth refresh lifecycle, queue consumer, and D1 writers.
- [ ] Add scheduled D1 backups (export + artifact retention) via GitHub Actions.
- [ ] Add optional data export endpoint (`/api/export`) for CSV pulls outside Grafana.
- [ ] Consider Cloudflare Secrets Store and dashboard provisioning automation as follow-up ops hardening.

---

## Architecture

Diagram source: `docs/architecture.excalidraw` (also see `architecture.svg`)

```mermaid
flowchart LR
  Oura["Oura Cloud API<br/>OAuth + Webhooks"]
  Worker["Cloudflare Worker<br/>oura-cf"]
  Webhook["/webhook/oura<br/>public"]
  Admin["/api/admin/oura/webhooks*<br/>Access + admin token"]
  Queue["Cloudflare Queue<br/>oura-webhook-events"]
  D1[("D1: oura_db")]
  KV[("KV: OURA_CACHE")]
  AE[("Analytics Engine")]
  WF["Backfill Workflow"]
  Cron["Cron<br/>0 */2 * * *"]
  Grafana["Grafana<br/>Infinity datasource"]

  Oura -->|webhook delivery| Webhook
  Oura -->|OAuth token exchange| Worker
  Webhook -->|verify + enqueue| Queue
  Queue -->|single-document ingest| Worker
  Worker --> D1
  Worker --> KV
  Worker --> AE
  Cron --> Worker
  WF --> Worker
  Admin --> Worker
  Grafana -->|POST /api/sql<br/>GET /api/stats| Worker
```

### How It Works

Three ingestion paths write data into D1, and one query path serves it to Grafana:

```
Oura Ring ──> Oura Cloud API
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
  WEBHOOK       CRON       BACKFILL
  (real-time)  (2h poll)  (manual, durable)
     │            │            │
     ▼            ▼            ▼
  Queue ──┐   syncData()   Workflows
          │       │            │
          └───────┴────────────┘
                  │
                  ▼
              saveToD1()
                  │
                  ▼
           D1 (9 tables)
                  │
                  ▼
         /api/sql (Grafana)
```

**Webhook** (primary, real-time): Oura pushes `create`/`update`/`delete` events to `/webhook/oura`. The handler validates the HMAC signature, deduplicates via KV (24h TTL), and enqueues to a Cloudflare Queue. The queue consumer fetches the full document from the Oura API and writes to D1.

**Cron** (reconciliation): Every 2 hours, discovers available endpoints from the Oura OpenAPI spec (cached 24h in KV), fetches the last 3 days of data with bounded concurrency (4 workers), and upserts into D1. Protected by a KV lock to prevent overlap.

**Backfill** (manual, durable): Admin triggers via `/backfill`. Uses Cloudflare Workflows for durable, step-by-step execution where each resource sync is independently retryable.

**Query path**: Grafana uses the Infinity datasource to `POST /api/sql` with raw SQL. The handler authenticates the Bearer token, validates the SQL is read-only, rejects overly large `UNION ALL` compound queries (>5 terms), checks the KV cache (6h TTL), executes against D1 with a 7s timeout and 50K row cap, then caches the result.

### Infrastructure Patterns

| Pattern                       | Implementation                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth**                      | Dual Bearer tokens: `GRAFANA_SECRET` (read-only) and `ADMIN_SECRET` (admin routes). Constant-time comparison via SHA-256 + `timingSafeEqual`. |
| **Rate limiting**             | Three Cloudflare Rate Limit bindings: public (1/min), authenticated (3000/min), failed auth (10/min).                                         |
| **Circuit breaker**           | Opens after 5 consecutive Oura API failures, half-opens after 5 min, resets on success.                                                       |
| **Token refresh dedup**       | Shared promise prevents concurrent OAuth refresh calls from racing.                                                                           |
| **Cron overlap protection**   | KV key `sync:cron_lock` with 2h TTL; deleted in `finally`.                                                                                    |
| **SQL injection prevention**  | `isReadOnlySql()` strips identifier quotes, blocks writes/DDL/PRAGMA/sensitive tables, and caps `UNION ALL` compounds at 5 terms.             |
| **Webhook replay protection** | KV-seen keys with 24h TTL prevent duplicate processing.                                                                                       |
| **Cache invalidation**        | `flushSqlCache()` wipes all `sql:` KV keys after any data write (cron, webhook, backfill).                                                    |
| **D1 batch chunking**         | `batchInChunks()` splits statements into groups of 100.                                                                                       |
| **Query complexity analysis** | Heuristic scoring (joins, subqueries, unions, GROUP BY); warns at score > 100.                                                                |
| **Analytics**                 | Auth attempts and SQL queries logged to Analytics Engine for observability.                                                                   |

### Technology Stack

| Component          | Technology             | Purpose                          |
| ------------------ | ---------------------- | -------------------------------- |
| **Runtime**        | Cloudflare Workers     | Edge computing platform          |
| **Database**       | Cloudflare D1 (SQLite) | Structured data storage          |
| **Cache**          | Cloudflare KV          | SQL query + OpenAPI spec caching |
| **Queueing**       | Cloudflare Queues      | Webhook event buffering          |
| **Workflows**      | Cloudflare Workflows   | Durable backfill orchestration   |
| **Analytics**      | Analytics Engine       | Query and auth metrics           |
| **Authentication** | Oura OAuth2            | Secure API access                |
| **Visualization**  | Grafana Cloud          | Dashboards and analytics         |
| **Language**       | TypeScript 5.9         | Type-safe development            |
| **Testing**        | Vitest + Workers Pool  | 57 tests with Miniflare bindings |
| **Deployment**     | Wrangler 4.81+         | CLI deployment tool              |

## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Oura Ring](https://ouraring.com/) with active subscription
- [Node.js 22+](https://nodejs.org/) installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Installation

Two deployment modes are supported:

- **Maintainer mode (fastest for this repo owner)**: use `wrangler.jsonc` as-is for production.
- **Starter mode (new deployers/forks)**: use `wrangler.starter.jsonc` and replace placeholder IDs.

#### Step 1: Oura Developer Portal

Before deploying, you need Oura API credentials:

1. Go to [cloud.ouraring.com](https://cloud.ouraring.com/) and sign in
2. Create a new application
3. Note your **Client ID** and **Client Secret**
4. Set the **Redirect URI** to `https://your-host/oauth/callback` (use your actual domain)

#### Step 2: Clone and Install

```bash
# Clone repository
git clone https://github.com/xxKeith20xx/oura-cf.git
cd oura-cf

# Install dependencies
npm install

# If deploying your own copy, use starter config
cp wrangler.starter.jsonc wrangler.local.jsonc
```

#### Step 3: Create Cloudflare Resources

```bash
# Create D1 database
npx wrangler d1 create oura-db
# Note the database_id from the output — update wrangler.local.jsonc

# Create KV namespace
npx wrangler kv namespace create OURA_CACHE
# Note the id from the output — update wrangler.local.jsonc

# Create Queue
npx wrangler queues create oura-webhook-events
```

#### Step 4: Configure Secrets

```bash
npx wrangler secret put GRAFANA_SECRET      # Token for Grafana datasource auth
npx wrangler secret put ADMIN_SECRET        # Token for manual admin operations
npx wrangler secret put OURA_CLIENT_ID      # From Oura developer portal
npx wrangler secret put OURA_CLIENT_SECRET  # From Oura developer portal
npx wrangler secret put OURA_WEBHOOK_CALLBACK_URL  # e.g. https://your-host/webhook/oura
npx wrangler secret put OURA_WEBHOOK_VERIFICATION_TOKEN  # Random string for webhook verification
```

#### Step 5: Apply Migrations and Deploy

```bash
# Apply database migrations
npx wrangler d1 migrations apply oura-db --remote

# Set your Cloudflare account ID (get from: npx wrangler whoami)
export CLOUDFLARE_ACCOUNT_ID=your-account-id

# Deploy to Cloudflare
npx wrangler deploy --config wrangler.local.jsonc
```

### Initial Data Sync

```bash
# Authorize Oura OAuth (visit URL in browser).
# If Access protects /oauth/start, also include CF-Access service token headers.
curl https://your-host/oauth/start \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"

# Complete OAuth flow, then backfill historical data
curl https://your-host/backfill?days=730 \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"

# Ensure webhook subscriptions are configured
curl -X POST https://your-host/api/admin/oura/webhooks/sync \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"

# Poll backfill status
curl "https://your-host/backfill/status?id=INSTANCE_ID" \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
```

## Data Model

### Database Schema

**daily_summaries** - Aggregated daily metrics

- Readiness Score (activity balance, HRV, temperature, etc.)
- Sleep Score (efficiency, latency, deep/REM/light sleep)
- Activity Score (steps, calories, training volume)
- Health Metrics (stress, resilience, SpO2, VO2 max, cardiovascular age)
- Sleep Timing (optimal bedtime, recommendation, status)

**sleep_episodes** - Detailed sleep sessions

- Sleep stages (deep, REM, light, awake durations)
- Heart rate (average, lowest)
- HRV, breathing rate, temperature deviation
- Sleep type (long sleep, nap, rest)

**heart_rate_samples** - 5-minute resolution HR data

- Timestamp, BPM, source (ring, workout, etc.)
- High-resolution data for detailed analysis

**activity_logs** - Workouts and sessions

- Exercise type, duration, intensity
- Calories burned, distance, average heart rate
- Meditation and breathing sessions

**enhanced_tags** - User-created tags and annotations

- Tag type, custom name, freeform comments
- Start/end dates with optional duration support

**rest_mode_periods** - Rest mode tracking

- Start/end dates and times
- Episode data (tags during rest mode)

**table_stats** - Pre-computed statistics (cache)

- Row counts, date ranges, last update time
- Reduces database load for dashboard queries

### Data Flow

**Dynamic Endpoint Discovery**: The Worker auto-discovers available Oura API endpoints by fetching the OpenAPI spec URL from the Oura docs page, with fallback to a known version. This makes the system resilient to Oura API version bumps.

```
Oura Docs Page → Discover Spec URL → Fetch OpenAPI Spec → KV Cache (24hr)
                                            ↓
                                     18 API Endpoints
                                            ↓
                                   Worker (parallel fetch)
                                            ↓
                                    D1 Database (upsert)
```

**Upsert Strategy**: Multiple Oura endpoints write to the same `daily_summaries` row (keyed by `day`), allowing data from `daily_readiness`, `daily_sleep`, `daily_activity`, and `sleep_time` to merge into a single denormalized record.

**Resource Aliases**: When Oura renames API endpoints across versions (e.g., `vo2_max` → `vO2_max`), the `RESOURCE_ALIASES` map normalizes names before D1 storage.

## API Endpoints

### Public Endpoints (No Auth)

| Endpoint          | Method | Description                                               | Rate Limit        |
| ----------------- | ------ | --------------------------------------------------------- | ----------------- |
| `/health`         | GET    | Health check (last sync info with auth; debug with admin) | 1 req/60s per IP  |
| `/favicon.ico`    | GET    | Ring emoji favicon                                        | Cached 1 year     |
| `/oauth/callback` | GET    | OAuth2 callback handler                                   | 10 req/60s per IP |
| `/webhook/oura`   | GET    | Oura webhook challenge verification                       | N/A               |
| `/webhook/oura`   | POST   | Oura signed webhook delivery endpoint                     | N/A               |

### Authenticated Endpoints (Require Bearer Token)

Rate limit: 3000 requests per minute per IP (applies to all authenticated endpoints)

| Endpoint                         | Method | Description                                                | Cache TTL |
| -------------------------------- | ------ | ---------------------------------------------------------- | --------- |
| `/api/db/info`                   | GET    | Database size and growth metrics                           | N/A       |
| `/status`                        | GET    | Pipeline status page (HTML) — record counts, last sync     | 5 minutes |
| `/oauth/start`                   | GET    | Initiate Oura OAuth flow                                   | N/A       |
| `/backfill`                      | GET    | Start backfill workflow (1 req/60s)                        | N/A       |
| `/backfill/status`               | GET    | Poll backfill workflow status                              | N/A       |
| `/api/daily_summaries`           | GET    | Query daily summaries table                                | 5 minutes |
| `/api/stats`                     | GET    | Pre-computed table statistics                              | 1 hour    |
| `/api/sql`                       | POST   | Execute read-only SQL queries                              | 6 hours   |
| `/api/admin/oura/webhooks`       | GET    | List Oura webhook subscriptions (admin only)               | N/A       |
| `/api/admin/oura/webhooks/sync`  | POST   | Ensure configured webhook subscriptions exist (admin only) | N/A       |
| `/api/admin/oura/webhooks/renew` | POST   | Renew expiring webhook subscriptions (admin only)          | N/A       |
| `/`                              | GET    | All daily summaries (sorted by day)                        | 5 minutes |

### Example: Backfill with Workflows

```bash
# Start a backfill (returns immediately with workflow instance ID)
curl "https://your-host/backfill?days=730" \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
# → 202 { "instanceId": "backfill-730d-offset0-...", "statusUrl": "/backfill/status?id=..." }

# Poll status until complete
curl "https://your-host/backfill/status?id=backfill-730d-offset0-..." \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
# → { "status": "running" }  ... then eventually:
# → { "status": "complete", "output": { "successful": 18, "failed": 0, "totalRequests": 42 } }

# Backfill specific resources only
curl "https://your-host/backfill?days=365&resources=heartrate,sleep" \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"

# Backfill with offset (skip recent days)
curl "https://your-host/backfill?days=365&offset_days=30" \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
```

### Example: SQL Query (Grafana)

```bash
curl -X POST https://your-host/api/sql \
  -H "Authorization: Bearer YOUR_GRAFANA_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT day, readiness_score, sleep_score FROM daily_summaries WHERE day >= date(\"now\", \"-30 days\") ORDER BY day",
    "params": []
  }'
```

## Backfill Workflows

Large backfills use [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) for durable, retryable execution. This solves the fundamental limitation of Workers: CPU time and subrequest limits that made large inline backfills unreliable.

### How It Works

1. **`/backfill`** dispatches a `BackfillWorkflow` instance and returns `202 Accepted` immediately
2. The Workflow runs as a series of durable steps:
   - **`discover-resources`** — Loads available resources from the Oura OpenAPI spec (3 retries)
   - **`sync:{resource}`** — One step per resource (e.g., `sync:heartrate`, `sync:sleep`), each with 3 retries, 5-minute timeout
   - **`update-stats`** — Refreshes the `table_stats` table
   - **`flush-cache`** — Invalidates all cached SQL query results in KV
3. **`/backfill/status?id=<instanceId>`** polls the workflow for progress

### Benefits Over Inline Execution

| Feature           | Previous (inline)                | Workflows                           |
| ----------------- | -------------------------------- | ----------------------------------- |
| **Duration**      | Limited by Workers timeout       | Runs for minutes/hours              |
| **Retries**       | Dead code (syncData never threw) | Per-step with exponential backoff   |
| **Isolation**     | One failure blocks all           | Each resource retries independently |
| **Observability** | Logs only                        | Status polling + structured output  |
| **Idempotency**   | No deduplication                 | Instance IDs prevent duplicates     |

### Cron Sync (unchanged)

The every-2-hours cron sync (`syncData`) remains inline — it only syncs 3 days of data, well within Workers limits. The Workflow is only used for `/backfill`.

## Deployment

### Maintainer Fast Deploy (current production)

```bash
npm run deploy:cf
```

### Manual Deployment

```bash
# Run database migrations (only when schema changes)
npm run db:migrate

# Deploy Worker
npx wrangler deploy

# Verify deployment
curl https://your-host/health
```

### Starter/Fork Deployment

```bash
# Use starter config with your own IDs
npx wrangler deploy --config wrangler.local.jsonc
```

### Custom Domain Setup

```bash
# Add custom domain via Cloudflare Dashboard
# Or update wrangler.jsonc:
{
  "routes": [
    {
      "pattern": "oura.yourdomain.com",
      "custom_domain": true
    }
  ]
}

# Deploy with custom domain
npx wrangler deploy
```

## Configuration

### Environment Variables (Secrets)

| Secret                              | Required | Description                                                                              |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `GRAFANA_SECRET`                    | Yes      | Bearer token for Grafana datasource auth                                                 |
| `ADMIN_SECRET`                      | No       | Separate token for manual admin operations                                               |
| `OURA_CLIENT_ID`                    | Yes      | OAuth2 client ID from Oura developer portal                                              |
| `OURA_CLIENT_SECRET`                | Yes      | OAuth2 client secret from Oura developer portal                                          |
| `OURA_WEBHOOK_CALLBACK_URL`         | Yes      | Public callback URL for Oura webhook subscriptions (for sync route)                      |
| `OURA_WEBHOOK_VERIFICATION_TOKEN`   | Yes      | Shared token used for Oura webhook challenge verification                                |
| `OURA_WEBHOOK_SIGNING_SECRET`       | No       | Optional webhook signature secret (defaults to `OURA_CLIENT_SECRET`)                     |
| `OURA_WEBHOOK_ALLOWED_SKEW_SECONDS` | No       | Allowed timestamp skew for webhook signatures (default: 300)                             |
| `OURA_WEBHOOK_DATA_TYPES`           | No       | Comma-separated webhook data types to manage via sync endpoint                           |
| `OURA_WEBHOOK_EVENT_TYPES`          | No       | Comma-separated event types (`create,update,delete`)                                     |
| `ALLOWED_ORIGINS`                   | No       | Comma-separated CORS origins (set in `wrangler.jsonc` vars; required for browser access) |
| `MAX_QUERY_ROWS`                    | No       | Maximum rows from SQL queries (default: 50000)                                           |
| `QUERY_TIMEOUT_MS`                  | No       | Query timeout in milliseconds (default: 7000, clamped to 1000-15000)                     |
| `LOG_SQL_PREVIEW`                   | No       | Set `false` to disable SQL preview text in logs/analytics                                |

### Wrangler Configuration

Key settings in `wrangler.jsonc`:

```jsonc
{
	"compatibility_date": "2026-02-24",
	"triggers": {
		"crons": ["0 */2 * * *"], // Sync every 2 hours
	},
	"queues": {
		"producers": [{ "binding": "OURA_WEBHOOK_QUEUE", "queue": "oura-webhook-events" }],
		"consumers": [
			{
				"queue": "oura-webhook-events",
				"max_batch_size": 10,
				"max_batch_timeout": 5,
				"max_retries": 8,
			},
		],
	},
	"workflows": [
		{
			"name": "backfill-workflow",
			"binding": "BACKFILL_WORKFLOW",
			"class_name": "BackfillWorkflow",
		},
	],
	"d1_databases": [
		{
			"binding": "oura_db",
			"database_id": "YOUR_D1_DATABASE_ID",
		},
	],
	"kv_namespaces": [
		{
			"binding": "OURA_CACHE",
			"id": "YOUR_KV_NAMESPACE_ID",
		},
	],
	"analytics_engine_datasets": [
		{
			"binding": "OURA_ANALYTICS",
			"dataset": "oura_metrics",
		},
	],
}
```

### Cloudflare Bindings

| Binding               | Type             | Purpose                                |
| --------------------- | ---------------- | -------------------------------------- |
| `oura_db`             | D1 Database      | Primary data storage                   |
| `OURA_CACHE`          | KV Namespace     | SQL query + OpenAPI spec caching       |
| `OURA_WEBHOOK_QUEUE`  | Queue            | Webhook event buffering + async ingest |
| `BACKFILL_WORKFLOW`   | Workflow         | Durable backfill orchestration         |
| `OURA_ANALYTICS`      | Analytics Engine | Query and auth metrics                 |
| `RATE_LIMITER`        | Rate Limit       | Public endpoint rate limiting          |
| `AUTH_RATE_LIMITER`   | Rate Limit       | Authenticated endpoint rate limiting   |
| `UNAUTH_RATE_LIMITER` | Rate Limit       | Unauthenticated rate limiting          |

## Cloudflare Access (Recommended)

For stronger perimeter auth and centralized audit logs, protect admin/API endpoints with Cloudflare Access.

### Setup

1. **Create Service Token** in Zero Trust Dashboard (Access → Service Auth → Service Tokens)
2. **Create Access Application** protecting admin/API paths
3. **Configure Policies**:
   - service token policy for machine clients (Grafana/automation)
   - optional human IdP policy (e.g. GitHub) for browser access
4. **Add Headers to Grafana** datasource configuration:
   - `CF-Access-Client-Id: <token-id>`
   - `CF-Access-Client-Secret: <token-secret>`

### Benefits

- **Observability**: Centralized access logs and analytics
- **Defense in Depth**: Multiple authentication layers
- **Token Rotation**: Supports graceful credential updates

**Path guidance**:

- Keep protected: `/api/*`, `/backfill`, `/oauth/start`
- Keep public: `/webhook/oura`, `/oauth/callback`, `/health`, `/favicon.ico`

## Grafana Setup

### Prerequisites

- Grafana Cloud account (free tier: 10k series, 50GB logs)
- Infinity datasource plugin installed

### Configuration Steps

1. **Install Infinity Plugin**

   ```
   Grafana → Plugins → Search "Infinity" → Install
   ```

2. **Create Datasource**
   - Name: `Oura API`
   - URL: `https://your-host/api/sql`
   - Method: `POST`
   - Custom HTTP Headers (see below)

3. **Import Dashboard**
   ```bash
   # Use provided dashboard JSON (contains https://YOUR_HOST placeholders)
   # These URLs are overridden by your datasource config — just import as-is
   cat grafana-dashboard-structured.json
   # Import via Grafana UI -> Dashboards -> Import
   ```

**Custom HTTP Headers Configuration:**

Without Cloudflare Access:

- `Authorization: Bearer YOUR_GRAFANA_SECRET`

With Cloudflare Access (recommended):

- `Authorization: Bearer YOUR_GRAFANA_SECRET`
- `CF-Access-Client-Id: <service-token-client-id>`
- `CF-Access-Client-Secret: <service-token-client-secret>`

### Dashboard Features

- **Comprehensive visualizations** across readiness, sleep, activity, stress, tags, and data quality sections
- **Time-series panels**: Readiness, sleep, activity trends
- **Stat panels**: Current scores, latest metrics, sleep timing
- **Bar charts**: Sleep stages, workout distribution, tag frequency
- **Tables**: Recent tags, rest mode periods, data coverage
- **Correlation analysis**: Sleep quality vs readiness, training load vs recovery

### Example Queries

**Readiness Trend (7-day rolling average)**:

```sql
WITH d AS (
  SELECT day, readiness_score AS score
  FROM daily_summaries
  WHERE readiness_score IS NOT NULL AND day >= date('now', '-2 years')
)
SELECT
  day||'T00:00:00Z' AS time,
  score,
  AVG(score) OVER (
    ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS score_7d
FROM d
ORDER BY day
```

## Security

### Authentication

- **Multi-token auth**: Separate `GRAFANA_SECRET` and `ADMIN_SECRET` for role separation
  - `GRAFANA_SECRET` — read-only access for Grafana datasource
  - `ADMIN_SECRET` — elevated access: enables debug output on `/health`, required for `/backfill`, `/oauth/start`, and `/api/admin/oura/webhooks*`
- **Timing-safe comparison**: Uses `crypto.subtle.timingSafeEqual` (SHA-256 hash both sides first) to prevent timing attacks
- **OAuth state validation**: 24-hour expiry with automatic cleanup via cron
- **Debug header protection**: `/health` request headers (including auth tokens) are never returned to non-admin callers

### SQL Injection Prevention

- **Read-only enforcement**: Blocks INSERT, UPDATE, DELETE, DROP, ALTER, PRAGMA, VACUUM, ATTACH, REPLACE INTO
- **Sensitive table filtering**: Queries against `oura_oauth_tokens` and `oura_oauth_states` are blocked (including quoted identifier variants like `"oura_oauth_tokens"`)
- **Comment stripping**: Removes `--` and `/* */` comments before validation
- **Compound SELECT guardrail**: Rejects queries with more than 5 `UNION ALL` terms before they hit D1 limits
- **Multi-statement blocking**: Rejects queries containing semicolons
- **Leading wildcard blocking**: Rejects `LIKE '%...'` patterns that force full table scans
- **LIMIT capping**: Injects/caps LIMIT to prevent unbounded result sets
- **Parameter validation**: Rejects objects/arrays in SQL params (only primitives allowed)

### Rate Limiting

| Tier            | Limit        | Scope                  |
| --------------- | ------------ | ---------------------- |
| Public          | 1 req/60s    | `/health`, backfill    |
| Unauthenticated | 10 req/60s   | Unknown endpoints      |
| Authenticated   | 3000 req/60s | All `/api/*` endpoints |

### Security Headers

All responses include: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: default-src 'none'`

## Development

### Local Development

```bash
# Start local dev server (binds to D1, KV, secrets)
npx wrangler dev

# Access local worker
curl http://localhost:8787/health
curl http://localhost:8787/status   # Pipeline status page (HTML)

# Run tests
npm test

# Run tests once
npm run test:run

# Type checking (clean — no generated types file needed)
npx tsc --noEmit
```

### Testing

The project uses Vitest with `@cloudflare/vitest-pool-workers` for testing against real Miniflare bindings:

```bash
npm test          # Watch mode
npm run test:run  # Single run

# 68 tests (66 passing, 2 skipped)
# Coverage: auth, health/status signals and freshness thresholds, SQL injection
#           (including quoted identifier bypass), param validation, LIMIT capping,
#           CORS origins, webhook queue reconciliation, backfill idempotency,
#           daily_summaries, 404 handling, root endpoint
```

### Project Structure

```
oura-cf/
├── src/
│   └── index.ts              # Main Worker + BackfillWorkflow (3,000+ lines)
├── test/
│   └── index.spec.ts         # 68 tests
├── migrations/
│   ├── 0001_init.sql         # Core tables
│   ├── 0002_oauth_tokens.sql # OAuth token storage
│   ├── 0003_placeholder.sql  # Numbering placeholder
│   ├── 0004_table_stats.sql  # Pre-computed statistics cache
│   ├── 0005_add_indexes.sql  # Performance indexes
│   ├── 0006_new_endpoints.sql # v1.28 tables (enhanced_tags, rest_mode_periods)
│   ├── 0007_optimize_indexes.sql # Drop redundant indexes
│   ├── 0008_covering_indexes.sql # Covering indexes for Grafana queries
│   ├── 0009_drop_unused_tables.sql # Drop unused tables
│   └── 0010_drop_user_tags.sql # Drop superseded user_tags table
├── scripts/
│   ├── smoke-test.sh        # Post-deploy endpoint smoke test
│   └── sync-version.sh      # Syncs version from package.json → wrangler.jsonc + vitest config
├── wrangler.jsonc            # Cloudflare configuration
├── wrangler.starter.jsonc    # Starter config for independent deployments
├── vitest.config.mts         # Test configuration
├── package.json              # Dependencies
├── tsconfig.json             # TypeScript config
├── grafana-dashboard-structured.json  # Grafana dashboard definition
├── CHANGELOG.md              # Version history
├── docs/
│   ├── architecture.excalidraw  # Editable architecture diagram
│   ├── architecture.svg         # Rendered architecture diagram
│   ├── RUNBOOK.md            # Ops runbook (OAuth/webhook/queue incidents)
│   ├── ENVIRONMENT.md        # Secrets, bindings, and Access path policy
│   ├── RELEASE_CHECKLIST.md  # Release process and post-deploy checks
│   ├── DECISIONS.md          # ADR-lite architecture decisions
│   └── KNOWN_ISSUES.md       # Active caveats and tradeoffs
├── AGENTS.md                 # AI contributor quick context
├── CONTRIBUTING.md           # Contribution guidelines
└── README.md                 # This file
```

### Key Functions

| Function                         | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `BackfillWorkflow.run()`         | Durable backfill with per-resource steps                       |
| `syncData()`                     | Parallel resource fetching orchestrator                        |
| `ingestResource()`               | Fetch data from Oura API with pagination                       |
| `saveToD1()`                     | Transform & save data to D1 (multi-resource upserts)           |
| `discoverOpenApiSpecUrl()`       | Auto-discover current Oura API spec URL                        |
| `loadOuraResourcesFromOpenApi()` | Dynamic endpoint discovery from OpenAPI spec                   |
| `getOuraAccessToken()`           | OAuth token management with auto-refresh                       |
| `queue()`                        | Async webhook event processing and targeted single-doc ingest  |
| `updateTableStats()`             | Pre-compute table statistics (7 tables)                        |
| `flushSqlCache()`                | Invalidate KV-cached SQL query results                         |
| `hashSqlQuery()`                 | SHA-256 cache key generation for SQL queries                   |
| `isReadOnlySql()`                | SQL injection prevention and query validation                  |
| `getBearerRole()`                | Returns `'admin'`, `'grafana'`, or `null` for a bearer token   |
| `constantTimeCompare()`          | Timing-safe token comparison via timingSafeEqual               |
| `getCorsOrigins()`               | Derives per-request CORS origins from env (no mutable globals) |

### Adding New Oura Endpoints

The system automatically detects new Oura API endpoints via OpenAPI spec. To add a new table:

1. Create D1 migration in `migrations/`
2. Add mapping logic in `saveToD1()` function
3. Deploy migration and Worker

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Quick summary:

- Use conventional commit messages (`feat:`, `fix:`, `docs:`)
- Update CHANGELOG.md for notable changes
- Test locally with `npm run test:run` before submitting
- Use `npm version patch|minor|major` to bump versions — the `version` hook auto-syncs `wrangler.jsonc` and `vitest.config.mts`
- Open an issue for major changes before starting work

## AI Development Resources

- Repo context for AI contributors: `AGENTS.md`
- Operational docs for AI sessions: `docs/RUNBOOK.md`, `docs/ENVIRONMENT.md`, `docs/DECISIONS.md`, `docs/KNOWN_ISSUES.md`
- Cloudflare Workers docs (LLM format): `https://developers.cloudflare.com/workers/llms-full.txt`
- Cloudflare D1 docs (LLM format): `https://developers.cloudflare.com/d1/llms-full.txt`
- Cloudflare MCP server docs: `https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

**TL;DR**: You can use, modify, and distribute this code freely. Attribution appreciated but not required.

---

**Project Repository**: [github.com/xxKeith20xx/oura-cf](https://github.com/xxKeith20xx/oura-cf)
