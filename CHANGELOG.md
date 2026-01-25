# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-26

### Added
- MIT License for open source distribution
- Rate limiting for public endpoints (`/health`, `/oauth/callback`)
- Comprehensive request/response logging for sync operations
- Performance tracking metrics (request counts, duration, success/failure rates)
- OpenCode style guide for consistent formatting

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

[1.0.0]: https://github.com/xxKeith20xx/oura-cf/compare/v0.0.0...v1.0.0
[0.0.0]: https://github.com/xxKeith20xx/oura-cf/releases/tag/v0.0.0
