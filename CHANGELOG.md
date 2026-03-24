# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-03-24

### Added

- **Public `/status` page**: HTML status page showing pipeline health, last sync time, and per-table record counts with 5-minute public cache. No auth required.
- **Sync health tracking**: Cron handler writes `sync:last_success` to KV after every successful run (timestamp, cron expression, duration). Visible in `/health` (with auth) and `/status`.
- **`getBearerRole()`**: Role-aware token validation returning `'admin'`, `'grafana'`, or `null`. Admin role unlocks debug output on `/health`.
- **`scripts/sync-version.sh`**: Version sync script invoked by the `npm version` lifecycle hook — keeps `wrangler.jsonc` and `vitest.config.mts` in sync with `package.json` automatically.
- **Architecture diagram**: `docs/architecture.svg` and `docs/architecture.excalidraw` added to the repo; embedded in README.
- **Roadmap section in README**: Checklist of next steps (modular refactor, Hono router, test coverage, D1 backup, export endpoint, Secrets Store).

### Security

- **Health endpoint header leak fixed**: `/health` previously returned all request headers (including `Authorization`) to any caller. Debug info (`request.*`, `cf.*`) is now gated behind `ADMIN_SECRET`. `authorization` and `cookie` headers are always stripped even for admin callers.
- **`_corsOrigins` mutable global eliminated**: Replaced module-level `let _corsOrigins` (written on every `fetch()`) with `getCorsOrigins(env)` called per-request and a request-scoped `cors()` helper. Removes implicit shared state between requests.
- **`Retry-After` header respected**: `fetchWithRetry` now honours the `Retry-After: <seconds>` header from the Oura API on 429 responses (capped at 60s), falling back to exponential backoff when absent.

### Changed

- **`user_tags` handler removed** from `saveToD1`: the legacy `tag` endpoint was still writing to the `user_tags` table, which was superseded by `enhanced_tags` in v1.2.0. The handler and `KNOWN_ENDPOINTS` entry have been removed.
- **TypeScript check enabled in CI** (`checks.yml`): `tsc --noEmit` and `vitest --run` are now part of every push/PR. Fixed the `webworker` lib conflict in `tsconfig.json` that previously blocked this.
- **`OuraApiResponse` type tightened**: `OuraApiResponse<unknown>` → `OuraApiResponse<Record<string, unknown>>` in `ingestResource`, fixing the last pre-existing TypeScript error.

### Fixed

- **`tsconfig.json` lib conflict**: Removed `"webworker"` from `lib` array — it conflicted with `@cloudflare/workers-types` (which already covers all Workers globals), causing ~50 type errors on `tsc --noEmit`.

### Removed

- **`latest` npm dependency**: Unused runtime dependency (203 transitive packages) removed.
- **`user_tags` table**: Migration `0010_drop_user_tags.sql` drops the table that was superseded by `enhanced_tags`.

## [1.3.0] - 2026-03-01

### Added

- **Cloudflare Workflows for Backfill**: `/backfill` now dispatches a durable `BackfillWorkflow` instead of running inline. Each Oura resource syncs as an isolated step with its own retry budget (3 retries, exponential backoff, 5-minute timeout). Eliminates CPU/subrequest limit concerns for large backfills.
- **`/backfill/status` Endpoint**: Poll workflow progress via `GET /backfill/status?id=<instanceId>`. Returns status (`queued`, `running`, `complete`, `errored`), error details, and structured output with per-resource results.
- **KV SQL Query Caching**: `/api/sql` responses cached in KV with SHA-256 hash keys and 6-hour TTL. Returns `X-Cache: HIT/MISS` header. Cache automatically flushed after cron sync and backfill workflow completion.
- **Analytics Engine Integration**: `OURA_ANALYTICS` binding logs SQL query metrics (execution time, row count, cache hit/miss) and auth attempts (success/failure, IP, country) to Cloudflare Analytics Engine.
- **49 Tests**: Comprehensive test suite covering auth (valid/invalid tokens), SQL injection prevention (INSERT, DELETE, DROP, UPDATE, ALTER, PRAGMA, VACUUM, ATTACH, multi-statement, comment-obfuscated, CTE-wrapped writes), REPLACE() function vs REPLACE INTO, parameter validation (objects, arrays, null, boolean), LIMIT capping (inject/preserve/cap), `/api/daily_summaries` (valid range, invalid dates, defaults), CORS origin rejection, 404 handling, root endpoint.
- **CORS Origin Configuration**: `ALLOWED_ORIGINS` env var for comma-separated CORS origins (default: `https://oura.keith20.dev`, `http://localhost:3000`, `http://localhost:8787`).
- **Date Param Validation**: `/api/daily_summaries` validates `start` and `end` params against `YYYY-MM-DD` regex.
- **SQL Param Validation**: Rejects objects and arrays in SQL params — only primitives (string, number, boolean, null) accepted.
- **Unknown Endpoint Logging**: `saveToD1` logs unknown endpoint names via `KNOWN_ENDPOINTS` set.
- **Stale OAuth State Cleanup**: Cron job deletes OAuth states older than 24 hours.
- **Database Migration `0008_covering_indexes.sql`**: 7 covering indexes for Grafana dashboard queries.
- **Database Migration `0009_drop_unused_tables.sql`**: Drops unused `oura_raw_documents` and `oura_sync_state` tables.
- **Database Migration `0003_placeholder.sql`**: No-op to fill migration numbering gap (0002 → 0004).

### Security

- **Timing-Safe Token Comparison**: Replaced hand-rolled HMAC comparison with `crypto.subtle.timingSafeEqual` (SHA-256 hashes both sides first).
- **`isReadOnlySql()` Fix**: `REPLACE()` string function no longer blocked — only `REPLACE INTO` (write operation) is rejected.
- **LIMIT Capping**: Injects `LIMIT maxRows+1` when absent, caps user-provided LIMIT when it exceeds `maxRows`. Strips trailing SQL comments before LIMIT detection.
- **`MAX_QUERY_ROWS`/`QUERY_TIMEOUT_MS` Validation**: NaN-safe with `Number.isFinite()` checks.
- **Security Headers**: All responses include `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Content-Security-Policy`.

### Fixed

- **`syncData` Now Throws on Majority Failure**: When >50% of resources fail, `syncData` throws so `retryWithBackoff` in the cron handler can actually retry. Previously it swallowed all errors, making the retry logic dead code.
- **`ingestResource` Error Propagation**: No longer silently returns on token acquisition failure — re-throws so failures are reported.
- **`loadOuraResourcesFromOpenApi` Error Handling**: Now throws on failure instead of returning empty array.
- **`flushSqlCache` Isolated from Cron Retry**: KV cache flush failure can no longer trigger unnecessary data re-sync.
- **`request.cf` Type**: Cast from `any` to `IncomingRequestCfProperties`.

### Changed

- **`/backfill` Endpoint**: Now dispatches to Cloudflare Workflow (returns 202 with instance ID and status URL) instead of running sync inline. All backfill sizes use the Workflow — no more waitUntil/synchronous split.
- **Build-Time Version**: Hardcoded `version: '1.1.0'` in `/health` response replaced with `__APP_VERSION__` injected via wrangler `define` (mirrors `package.json`).
- **`package.json` Name**: Fixed `oura-vault` → `oura-cf` to match wrangler config.
- **KV `remote: true` Removed**: Local dev no longer hits production KV namespace.
- **`worker-configuration.d.ts`**: Added to `.gitignore` (stale generated file).
- **`saveToD1` Type**: `data` param typed `Record<string, any>[]` instead of `any[]`.
- **Dead Code Cleanup**: Removed unused `ALLOWED_SQL_KEYWORDS` and `ALLOWED_SQL_FUNCTIONS` sets, removed 19 redundant `timestamp: new Date().toISOString()` from log calls.

### Documentation

- **README.md**: Rewritten with Workflows section, security section, backfill status polling examples, updated architecture diagram, updated tables and file listing.
- **Grafana Dashboard**: Removed aggressive auto-refresh intervals (minimum 15 minutes).

## [1.2.0] - 2026-02-24

### Performance

- **O(1) Index Lookups in `updateTableStats()`**: Removed `substr()` from `MIN()`/`MAX()` on `heart_rate_samples.timestamp` and `activity_logs.start_datetime` — SQLite now uses B-tree index lookups instead of full table scans. Date truncation moved to JS `.substring(0, 10)`.
- **Parallel Stat Queries**: `updateTableStats()` now runs all stat queries with `Promise.allSettled()` instead of sequentially, with per-table error logging for rejected queries.
- **LIMIT Injection on `/api/sql`**: Injects `LIMIT maxRows+1` when absent, caps user-provided LIMIT when it exceeds `maxRows`. Strips trailing SQL comments (`--` and `/* */`) before LIMIT detection to prevent bypass. Uses positional replacement to avoid matching LIMIT in subqueries.
- **Bounded Root Endpoint**: `/` now defaults to 90 days with parameterized `?days=N` (max 3650) instead of unbounded `SELECT *`.
- **Bounded `/api/daily_summaries`**: Defaults to 90-day range when no `start` param provided.
- **Fallback Stats Query Optimization**: Same `substr()` removal in the UNION ALL fallback at `/api/stats`, with JS-side date truncation.

### Added

- **Database Migration `0007_optimize_indexes.sql`**:
  - Drop redundant PK-duplicate indexes (`idx_daily_summaries_day`, `idx_heart_rate_samples_timestamp`)
  - Drop indexes on unused `oura_raw_documents` table
  - Add `idx_user_tags_day` index
- **Grafana Dashboard — New Panels**:
  - Awake Duration (min) — sleep_episodes awake time
  - SpO2 % Over Time — blood oxygen saturation trend
  - Cardiovascular Age Offset — CV age trend over time
  - Resilience Level — daily resilience mapped 1–4 as points
  - Daily HR Range (samples) — daily min/avg/max BPM from heart_rate_samples (90d)
  - HR by Source (daily avg) — avg BPM by source: awake/rest/sleep/etc (90d)
- **Heart Rate Samples row** — new collapsed dashboard section for intraday HR data

### Fixed

- **Grafana Dashboard — 7 panels with 90-day range**: Panels 1104, 1104b, 1211, 1306, 1805, 1806, 1807 changed from `date('now', '-90 days')` to `date('now', '-2 years')` to match the rest of the dashboard.
- **Orphaned stat panels**: Panels 1007–1010 (Stress Index, Resilience, SpO2 %, CV Age Offset) were missing from layout; restored to Snapshot row.

### Removed

- **Grafana Dashboard — Panels with no data**: Removed 6 panels where the underlying Oura API returns NULL for all rows:
  - VO2 Max (stat + time-series)
  - Bedtime Recommendation, Sleep Timing Status, Optimal Bedtime (stats)
  - Workout Avg HR (time-series)

### Changed

- **Wrangler**: Bumped from ^4.63.0 to ^4.68.0
- **Dashboard total**: 54 → 56 panels, 10 → 11 rows

## [1.1.0] - 2026-02-08

### Added

- **New Oura API v1.28 Endpoints**: Support for 3 new data sources
  - `enhanced_tag` → `enhanced_tags` table (richer tags with duration, custom names)
  - `rest_mode_period` → `rest_mode_periods` table (rest mode tracking with episodes)
  - `sleep_time` → `daily_summaries` columns (optimal bedtime, recommendation, status)
- **Dynamic OpenAPI Spec Discovery**: Worker now auto-discovers the current Oura API spec URL
  - Fetches `https://cloud.ouraring.com/v2/docs` and parses the `<redoc spec-url>` attribute
  - Falls back to hardcoded URL if discovery fails
  - Resilient to future Oura API version bumps without code changes
- **Resource Alias System**: `RESOURCE_ALIASES` map handles Oura API renames across versions
  - `vO2_max` (v1.28) automatically normalized to `vo2_max` for D1 storage
- **Admin Secret**: Separate `ADMIN_SECRET` for manual operations (backfill, etc.)
  - Decoupled from `GRAFANA_SECRET` which is managed by Grafana's service token
- **Database Migration**: `0006_new_endpoints.sql`
  - `enhanced_tags` table with index on `start_day`
  - `rest_mode_periods` table with index on `start_day`
  - 3 new columns on `daily_summaries`: `sleep_time_optimal_bedtime`, `sleep_time_recommendation`, `sleep_time_status`
- **Grafana Dashboard**: 8 new panels across 3 sections (46 → 54 panels, 9 → 10 rows)
  - Sleep Deep Dive: Bedtime Recommendation, Sleep Timing Status, Optimal Bedtime
  - Stress & Recovery: Rest Mode Periods table, Rest Mode Activations stat
  - Tags & Annotations (new row): Recent Tags table, Tag Types pie chart, Tags per Month timeseries
- **Table Stats**: `enhanced_tags` and `rest_mode_periods` added to `/api/stats` and `updateTableStats()`

### Fixed

- **Critical: OpenAPI Spec URL 404**: Oura updated their API spec from v1.27 to v1.28, breaking the hardcoded URL
  - `loadOuraResourcesFromOpenApi()` returned empty array, causing all cron syncs to silently do nothing
  - Dynamic discovery prevents this class of failure from recurring
- **Silent Sync Failures**: `ingestResource()` no longer swallows token acquisition errors
  - Previously returned silently on auth failure; now re-throws so `syncData()` reports it as a failed resource

### Changed

- **Auth Simplification**: Removed unused `GRAFANA_SECRET_2` and `GRAFANA_SECRET_3` token rotation
  - Auth now checks `GRAFANA_SECRET` + `ADMIN_SECRET` only
- **Backfill Rate Limit**: Restored dedicated 1 req/60s rate limit for `/backfill` endpoint
  - Uses `RATE_LIMITER` with `backfill:` key prefix (independent from `/health` bucket)
- **`saveToD1()`**: All endpoint matching now uses `normalizedEndpoint` via `RESOURCE_ALIASES`

## [1.0.5] - 2026-02-07

### Fixed

- **Critical: Rate Limiting Bug**: Fixed authentication order that caused all requests to hit 10 req/min limit
  - Previously: `UNAUTH_RATE_LIMITER` was checked BEFORE authentication validation
  - Now: Authentication is validated first, then appropriate rate limiter is applied
  - Authenticated requests now correctly use `AUTH_RATE_LIMITER` (3000 req/min)

### Changed

- **Wrangler**: Updated to v4.63.0

## [1.0.4] - 2026-02-07

### Changed

- **Rate Limiting**: Significantly increased authenticated rate limits for Grafana
  - `AUTH_RATE_LIMITER`: 300 → 3000 requests per minute (50 req/sec sustained)
  - Supports 46-panel dashboard with multiple rapid refreshes (92 req per load)
- **Rate Limit Keys**: Implemented composite keys to prevent collision behind proxies
  - Authenticated keys now combine IP + token hash to differentiate users
  - Prevents rate limit sharing for users behind same proxy/CDN

### Added

- **Observability**: Workers tracing enabled for performance insights
  - Automatic distributed tracing for all requests
  - Performance monitoring via Cloudflare dashboard
- **Database Indexes**: Added performance indexes for Grafana queries
  - `idx_daily_summaries_day`, `idx_sleep_episodes_day`, `idx_activity_logs_start_datetime`
  - Improves query performance as data grows
- **Security Hardening**:
  - Fixed SQL injection risk in table name validation (static regex patterns)
  - Request body size limit (1MB) to prevent memory exhaustion
  - Input validation for OAuth state/code parameters
  - Resource filter validation (alphanumeric only, max 20 resources)
- **Reliability**:
  - Cron sync error recovery with exponential backoff (3 retries)
  - Circuit breaker pattern for Oura API calls (5 failures → 5min cooldown)
  - Prevents hammering Oura API when it's down
- **API Consistency**: All error responses now return JSON format
  - Standardized error format: `{ error: "message" }` or `{ message: "success" }`

### Fixed

- **404 Handler**: Proper CORS headers on 404 responses
- **Rate Limit Messages**: Updated to reflect actual 900 req/min limit

## [1.0.3] - 2026-02-01

### Changed

- **Rate Limiting**: Relaxed authenticated endpoint rate limits to better support Grafana dashboards
  - `AUTH_RATE_LIMITER`: 60 → 300 requests per minute (5 req/sec sustained)
  - `UNAUTH_RATE_LIMITER`: 5 → 10 requests per minute
  - Fixes 429 errors when loading Grafana dashboards with multiple panels

### Documentation

- Added Cloudflare Access setup guide for optional enhanced security
- Updated Grafana configuration to document both authentication methods
- Updated rate limit documentation to reflect new limits

## [1.0.1] - 2026-01-26

### Security

- Removed `account_id` from `wrangler.jsonc` (now uses `CLOUDFLARE_ACCOUNT_ID` env var)
- Redacted account_id from git history to prevent exposure
- Added separate rate limiter for authenticated endpoints (60 req/min)

### Fixed

- Grafana dashboard 429 errors caused by overly restrictive rate limiting
- Health endpoint now properly includes request metadata for debugging

### Added

- `.dev.vars.example` file to document environment variables
- Documentation for `CLOUDFLARE_ACCOUNT_ID` environment variable in README
- Separate `AUTH_RATE_LIMITER` binding for authenticated endpoints

### Changed

- Rate limiting now uses two separate limiters:
  - `RATE_LIMITER`: 1 req/60s for public endpoints (`/health`, `/oauth/callback`)
  - `AUTH_RATE_LIMITER`: 60 req/min for authenticated endpoints

## [1.0.0] - 2026-01-26

### Added

- MIT License for open source distribution
- Rate limiting for public endpoints (`/health`, `/oauth/callback`)
- Rate limiting for authenticated endpoints (60 requests per minute)
- Comprehensive request/response logging for sync operations
- Performance tracking metrics (request counts, duration, success/failure rates)
- OpenCode style guide for consistent formatting
- Dependabot configuration with weekly grouped updates
- Auto-merge workflow for patch version updates
- CONTRIBUTING.md with contribution guidelines

### Changed

- **PERFORMANCE**: Implemented parallel resource fetching for 3-5x faster data syncs
  - 3-day sync: 9-12s → 2-3s
  - 730-day backfill: 60-90s → 15-25s
  - Processes all 18 Oura API resources concurrently (within 5000 req/5min limit)
- **MEMORY**: Replaced `.map()` with `for...of` loops in 12 data processing functions
  - Reduces peak memory usage by 300-500 KB per sync (20-30% reduction)
  - Batched heart rate processing (500 samples per batch)
- Updated dependencies to latest versions
  - Wrangler: 4.54.0 → 4.60.0
  - @cloudflare/workers-types: 4.20251225.0 → 4.20260124.0
  - @cloudflare/vitest-pool-workers: 0.8.19 → 0.12.6

### Fixed

- Removed invalid `custom_domains` field from `wrangler.jsonc` (eliminated CLI warnings)
- Fixed `waitUntil()` timeout errors during large backfills
  - Small syncs (≤1 day): Use background processing
  - Large syncs (>1 day): Synchronous execution for guaranteed completion

### Security

- Rate limiting added to prevent abuse of public endpoints
- OAuth callback now rate-limited (1 req/60s per IP)
- Health check endpoint rate-limited (1 req/60s per IP)
- Authenticated endpoints rate-limited (60 req/min per IP)

## [0.0.0] - 2025-12-26 to 2026-01-25

### Added

- Initial Cloudflare Worker setup for Oura Ring data synchronization
- D1 database integration with migration system
  - `daily_summaries` table (readiness, sleep, activity scores)
  - `sleep_episodes` table (detailed sleep data)
  - `heart_rate_samples` table (5-minute resolution data)
  - `activity_logs` table (workouts, sessions, tags)
  - `table_stats` table (pre-computed statistics cache)
- OAuth2 authentication flow for Oura API
  - `/oauth/start` endpoint for authorization
  - `/oauth/callback` endpoint for token exchange
  - Automatic token refresh with expiration handling
  - In-memory token caching (survives Worker instance lifetime)
- Grafana dashboard integration
  - `/api/sql` endpoint for read-only SQL queries
  - `/api/daily_summaries` endpoint for time-series data
  - `/api/stats` endpoint for pre-computed table statistics
  - Infinity datasource configuration
- Historical data backfill system
  - `/backfill` endpoint with configurable date ranges
  - Resource filtering support
  - Rate limiting (1 request per 60 seconds per IP)
  - Chunked processing to avoid Worker timeouts
- Automated cron sync (3 times daily: 1am, 12pm, 6pm)
- KV cache for OpenAPI spec (24-hour TTL)
  - Eliminates repeated HTTP calls to Oura API
  - Reduces sync overhead by ~300ms per execution
- Response caching with appropriate TTLs
  - Data endpoints: 5 minutes (private cache)
  - Stats endpoint: 1 hour (private cache)
  - Static assets: 1 year (public cache)
- CORS support for Grafana Cloud integration
- Custom domain configuration (`oura.keith20.dev`)
- Comprehensive error handling and logging
- Health check endpoint (`/health`) with request diagnostics

### Performance Optimizations

- Pre-computed table statistics (reduces 1M reads/day to 12 reads/day)
- Cache-Control headers for edge caching
- Optimized D1 queries with proper indexing
- In-memory OAuth token caching (eliminates redundant D1 queries)
- Heart rate sample batching (500 samples per D1 batch operation)

### Database

- Created D1 database schema with 7 tables
- Applied 4 migrations:
  - `0001_init.sql` - Core tables (daily_summaries, sleep_episodes, etc.)
  - `0002_oauth_tokens.sql` - OAuth state and token storage
  - `0003_activity_logs.sql` - Workout and session tracking
  - `0004_table_stats.sql` - Statistics caching table
- Implemented upsert logic for merging data from multiple Oura endpoints

### Security

- Bearer token authentication for all API endpoints
- Read-only SQL validation (prevents data modification)
- OAuth state validation with 15-minute expiration
- CORS whitelist for approved origins
- Sensitive table filtering (OAuth tokens excluded from `/api/sql`)

### Documentation

- Comprehensive README with architecture overview
- Setup and deployment instructions
- Backfill script examples
- Security review documentation
- Performance optimization guides

[1.3.0]: https://github.com/xxKeith20xx/oura-cf/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/xxKeith20xx/oura-cf/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/xxKeith20xx/oura-cf/compare/v1.0.5...v1.1.0
[1.0.5]: https://github.com/xxKeith20xx/oura-cf/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/xxKeith20xx/oura-cf/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/xxKeith20xx/oura-cf/compare/v1.0.1...v1.0.3
[1.0.1]: https://github.com/xxKeith20xx/oura-cf/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/xxKeith20xx/oura-cf/compare/v0.0.0...v1.0.0
[0.0.0]: https://github.com/xxKeith20xx/oura-cf/releases/tag/v0.0.0
