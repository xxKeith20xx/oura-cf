# Oura Ring Data Sync & Analytics Platform

A Cloudflare Worker that syncs Oura Ring health data to a D1 database and serves it to Grafana for visualization and analytics.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)

## ✨ Features

- **📊 Complete Data Coverage**: Syncs all Oura Ring v2 API endpoints (18+ resources)
- **🔄 Automated Sync**: Cron-based data updates (3x daily: 1am, 12pm, 6pm)
- **📈 Grafana Integration**: Pre-built dashboard with 40+ visualizations
- **🔒 Enterprise Security**: Multi-token auth, constant-time comparison, 3-tier rate limiting, query timeouts
- **💰 Cost-Efficient**: Runs within Cloudflare's free tier limits
- **⚡ Low Latency**: Edge caching with appropriate TTL strategies
- **🛡️ Production-Ready**: Comprehensive logging, error handling, and monitoring

## 📋 Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Data Model](#data-model)
- [API Endpoints](#api-endpoints)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Cloudflare Access (Optional)](#cloudflare-access-optional)
- [Grafana Setup](#grafana-setup)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## 🏗️ Architecture

```
┌─────────────────┐
│   Oura Ring     │
└────────┬────────┘
         │ OAuth2
         ▼
┌─────────────────────────────────────────────┐
│  Cloudflare Worker (oura-cf)                │
│                                             │
│  ┌──────────────┐      ┌──────────────┐   │
│  │ Sync Engine  │─────▶│   D1 DB      │   │
│  │ (Parallel)   │      │ (5 tables)   │   │
│  └──────────────┘      └──────────────┘   │
│                                             │
│  ┌──────────────┐      ┌──────────────┐   │
│  │ REST API     │      │  KV Cache    │   │
│  │ (/api/*)     │      │ (OpenAPI)    │   │
│  └──────────────┘      └──────────────┘   │
└─────────────┬───────────────────────────────┘
              │ HTTPS + Auth
              ▼
    ┌─────────────────┐
    │ Grafana Cloud   │
    │ (Infinity DS)   │
    └─────────────────┘
```

### Technology Stack

| Component          | Technology             | Purpose                         |
| ------------------ | ---------------------- | ------------------------------- |
| **Runtime**        | Cloudflare Workers     | Edge computing platform         |
| **Database**       | Cloudflare D1 (SQLite) | Structured data storage         |
| **Cache**          | Cloudflare KV          | OpenAPI spec caching (24hr TTL) |
| **Authentication** | Oura OAuth2            | Secure API access               |
| **Visualization**  | Grafana Cloud          | Dashboards and analytics        |
| **Language**       | TypeScript 5.9         | Type-safe development           |
| **Deployment**     | Wrangler 4.60          | CLI deployment tool             |

## 🚀 Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Oura Ring](https://ouraring.com/) with active subscription
- [Node.js 22+](https://nodejs.org/) installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Installation

```bash
# Clone repository
git clone https://github.com/xxKeith20xx/oura-cf.git
cd oura-cf

# Install dependencies
npm install

# Configure Cloudflare secrets
npx wrangler secret put GRAFANA_SECRET      # Your secret for Grafana auth
npx wrangler secret put OURA_CLIENT_ID      # From Oura developer portal
npx wrangler secret put OURA_CLIENT_SECRET  # From Oura developer portal

# Create D1 database
npx wrangler d1 create oura-db

# Update wrangler.jsonc with your database_id (from previous command)

# Apply database migrations
npx wrangler d1 migrations apply oura-db --remote

# Set your Cloudflare account ID (get from: npx wrangler whoami)
export CLOUDFLARE_ACCOUNT_ID=your-account-id

# Deploy to Cloudflare
npx wrangler deploy
```

### Initial Data Sync

```bash
# Authorize Oura OAuth (visit URL in browser)
curl https://your-worker.workers.dev/oauth/start \
  -H "Authorization: Bearer YOUR_GRAFANA_SECRET"

# Complete OAuth flow, then backfill historical data
curl https://your-worker.workers.dev/backfill?days=730 \
  -H "Authorization: Bearer YOUR_GRAFANA_SECRET"
```

## 📊 Data Model

### Database Schema

**daily_summaries** - Aggregated daily metrics

- Readiness Score (activity balance, HRV, temperature, etc.)
- Sleep Score (efficiency, latency, deep/REM/light sleep)
- Activity Score (steps, calories, training volume)
- Health Metrics (stress, resilience, SpO2, VO2 max, cardiovascular age)

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

**table_stats** - Pre-computed statistics (cache)

- Row counts, date ranges, last update time
- Reduces database load for dashboard queries

### Data Flow

```
Oura API → Worker → D1 Database
   ↓                    ↓
OpenAPI Spec      Upsert Logic
(18 endpoints)    (Merge data)
```

**Upsert Strategy**: Multiple Oura endpoints write to the same `daily_summaries` row (keyed by `day`), allowing data from `daily_readiness`, `daily_sleep`, and `daily_activity` to merge into a single denormalized record.

## 🔌 API Endpoints

### Public Endpoints (No Auth)

| Endpoint          | Method | Description                       | Rate Limit        |
| ----------------- | ------ | --------------------------------- | ----------------- |
| `/health`         | GET    | Health check with request details | 1 req/60s per IP  |
| `/favicon.ico`    | GET    | Ring emoji favicon                | Cached 1 year     |
| `/oauth/callback` | GET    | OAuth2 callback handler           | 10 req/60s per IP |

### Authenticated Endpoints (Require Bearer Token)

Rate limit: 300 requests per minute per IP (applies to all authenticated endpoints)

| Endpoint               | Method | Description                         | Cache TTL |
| ---------------------- | ------ | ----------------------------------- | --------- |
| `/oauth/start`         | GET    | Initiate Oura OAuth flow            | N/A       |
| `/backfill`            | GET    | Sync historical data                | N/A       |
| `/api/daily_summaries` | GET    | Query daily summaries table         | 5 minutes |
| `/api/stats`           | GET    | Pre-computed table statistics       | 1 hour    |
| `/api/sql`             | POST   | Execute read-only SQL queries       | 5 minutes |
| `/`                    | GET    | All daily summaries (sorted by day) | 5 minutes |

### Example: Backfill Query

```bash
# Sync last 7 days for specific resources
curl "https://your-worker.workers.dev/backfill?days=7&resources=daily_sleep,daily_activity" \
  -H "Authorization: Bearer YOUR_GRAFANA_SECRET"

# Large backfill (730 days) - runs synchronously
curl "https://your-worker.workers.dev/backfill?days=730" \
  -H "Authorization: Bearer YOUR_GRAFANA_SECRET"
```

### Example: SQL Query (Grafana)

```bash
curl -X POST https://your-worker.workers.dev/api/sql \
  -H "Authorization: Bearer YOUR_GRAFANA_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "SELECT day, readiness_score, sleep_score FROM daily_summaries WHERE day >= date(\"now\", \"-30 days\") ORDER BY day",
    "params": []
  }'
```

## 🚢 Deployment

### Manual Deployment

```bash
# Run database migrations (if schema changed)
npx wrangler d1 migrations apply oura-db --remote

# Deploy Worker
npx wrangler deploy

# Verify deployment
curl https://your-worker.workers.dev/health
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

## ⚙️ Configuration

### Environment Variables (Secrets)

| Secret               | Required | Description                                     |
| -------------------- | -------- | ----------------------------------------------- |
| `GRAFANA_SECRET`     | Yes      | Bearer token for API authentication (primary)   |
| `GRAFANA_SECRET_2`   | No       | Secondary token for zero-downtime rotation      |
| `GRAFANA_SECRET_3`   | No       | Tertiary token for zero-downtime rotation       |
| `OURA_CLIENT_ID`     | Yes      | OAuth2 client ID from Oura developer portal     |
| `OURA_CLIENT_SECRET` | Yes      | OAuth2 client secret from Oura developer portal |
| `OURA_PAT`           | No       | Personal access token (alternative to OAuth)    |
| `MAX_QUERY_ROWS`     | No       | Maximum rows from SQL queries (default: 50000)  |
| `QUERY_TIMEOUT_MS`   | No       | Query timeout in milliseconds (default: 10000)  |

### Wrangler Configuration

Key settings in `wrangler.jsonc`:

```jsonc
{
	"compatibility_date": "2026-01-20",
	"triggers": {
		"crons": ["0 1,12,18 * * *"], // Sync 3x daily
	},
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
}
```

## 🔐 Cloudflare Access (Optional)

For enhanced security and centralized audit logs, protect API endpoints with Cloudflare Access service tokens.

### Setup

1. **Create Service Token** in Zero Trust Dashboard (Access → Service Auth → Service Tokens)
2. **Create Access Application** protecting your API endpoints
3. **Configure Policy** with Service Auth action
4. **Add Headers to Grafana** datasource configuration:
   - `CF-Access-Client-Id: <token-id>`
   - `CF-Access-Client-Secret: <token-secret>`

### Benefits

- **Observability**: Centralized access logs and analytics
- **Defense in Depth**: Multiple authentication layers
- **Token Rotation**: Supports graceful credential updates

**Note**: Public endpoints (`/health`, `/oauth/callback`, favicons) should remain unprotected to ensure OAuth flow and monitoring continue to function.

## 📈 Grafana Setup

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
   - URL: `https://your-worker.workers.dev/api/sql`
   - Method: `POST`
   - Custom HTTP Headers (see below)

3. **Import Dashboard**
   ```bash
   # Use provided dashboard JSON
   cat grafana-dashboard-structured.json
   # Import via Grafana UI → Dashboards → Import
   ```

**Custom HTTP Headers Configuration:**

Without Cloudflare Access:

- `Authorization: Bearer YOUR_GRAFANA_SECRET`

With Cloudflare Access (recommended):

- `Authorization: Bearer YOUR_GRAFANA_SECRET`
- `CF-Access-Client-Id: <service-token-client-id>`
- `CF-Access-Client-Secret: <service-token-client-secret>`

### Dashboard Features

- **40+ Visualizations** across 8 categories
- **Time-series panels**: Readiness, sleep, activity trends
- **Stat panels**: Current scores, latest metrics
- **Bar charts**: Sleep stages, workout distribution
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

## 🛠️ Development

### Local Development

```bash
# Start local dev server (binds to D1, KV, secrets)
npx wrangler dev

# Access local worker
curl http://localhost:8787/health

# Run tests
npm test

# Type checking
npm run cf-typegen && npx tsc --noEmit
```

### Project Structure

```
oura-cf/
├── src/
│   └── index.ts              # Main Worker code (1,300+ lines)
├── migrations/
│   ├── 0001_init.sql         # Core tables (daily_summaries, sleep_episodes, heart_rate_samples, activity_logs)
│   ├── 0002_oauth_tokens.sql # OAuth token storage
│   └── 0004_table_stats.sql  # Pre-computed statistics cache
├── wrangler.jsonc            # Cloudflare configuration
├── package.json              # Dependencies
├── tsconfig.json             # TypeScript config
├── grafana-dashboard-structured.json  # Grafana dashboard
├── CHANGELOG.md              # Version history
├── CONTRIBUTING.md           # Contribution guidelines
└── README.md                 # This file
```

### Key Functions

| Function                         | Purpose                                      | Lines     |
| -------------------------------- | -------------------------------------------- | --------- |
| `syncData()`                     | Parallel resource fetching orchestrator      | 80 lines  |
| `ingestResource()`               | Fetch data from Oura API with pagination     | 70 lines  |
| `saveToD1()`                     | Transform & save data to D1 (12 endpoints)   | 350 lines |
| `loadOuraResourcesFromOpenApi()` | Dynamic endpoint discovery from OpenAPI spec | 80 lines  |
| `getOuraAccessToken()`           | OAuth token management with auto-refresh     | 60 lines  |
| `updateTableStats()`             | Pre-compute table statistics                 | 60 lines  |

### Adding New Oura Endpoints

The system automatically detects new Oura API endpoints via OpenAPI spec. To add a new table:

1. Create D1 migration in `migrations/`
2. Add mapping logic in `saveToD1()` function
3. Deploy migration and Worker

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Quick summary:

- Use conventional commit messages (`feat:`, `fix:`, `docs:`)
- Update CHANGELOG.md for notable changes
- Test locally with `wrangler dev` before submitting
- Open an issue for major changes before starting work

## 🤖 AI Development Resources

Working with Cloudflare Workers and need AI assistance? These LLM-optimized resources are designed to help AI tools provide better, more accurate answers:

### LLM-Optimized Documentation

These URLs are specifically formatted for LLMs to consume as context:

- **[Complete Developer Platform Docs](https://developers.cloudflare.com/developer-platform/llms-full.txt)** - Full Cloudflare developer documentation in LLM-friendly text format
- **[Workers Documentation](https://developers.cloudflare.com/workers/llms-full.txt)** - Workers-specific documentation for AI tools
- **[D1 Database Documentation](https://developers.cloudflare.com/d1/llms-full.txt)** - D1 SQL database reference
- **[KV Documentation](https://developers.cloudflare.com/kv/llms-full.txt)** - Workers KV key-value storage
- **[Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/llms-full.txt)** - Stateful object coordination
- **[R2 Documentation](https://developers.cloudflare.com/r2/llms-full.txt)** - Object storage reference
- **[Workers AI Documentation](https://developers.cloudflare.com/workers-ai/llms-full.txt)** - AI inference on the edge
- **[Vectorize Documentation](https://developers.cloudflare.com/vectorize/llms-full.txt)** - Vector database for embeddings
- **[AI Gateway Documentation](https://developers.cloudflare.com/ai-gateway/llms-full.txt)** - AI API caching and observability

### Model Context Protocol (MCP) Servers

Connect your AI tools directly to Cloudflare's infrastructure:

- **[MCP Servers for Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/)** - Official MCP server integrations
  - **Cloudflare MCP Server** - Query D1, KV, R2, and manage Workers
  - **Wrangler MCP Server** - Deploy and manage Workers directly from AI tools

### How to Use These Resources

**For ChatGPT, Claude, or other LLMs:**

```
Read the Cloudflare Workers documentation: https://developers.cloudflare.com/workers/llms-full.txt

Then help me with: [your question about this project]
```

**For AI Code Editors (Cursor, Windsurf, etc.):**

- Add the `/llms-full.txt` URLs to your project context
- Install MCP servers for real-time Cloudflare API access

**For This Project Specifically:**

```
Context: Cloudflare Worker syncing Oura Ring health data to D1 database
Stack: TypeScript, Hono router, OAuth2, D1, KV, cron triggers
Docs needed: https://developers.cloudflare.com/workers/llms-full.txt
             https://developers.cloudflare.com/d1/llms-full.txt
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

**TL;DR**: You can use, modify, and distribute this code freely. Attribution appreciated but not required.

---

**Project Repository**: [github.com/xxKeith20xx/oura-cf](https://github.com/xxKeith20xx/oura-cf)
