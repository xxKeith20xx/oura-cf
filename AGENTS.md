# AGENTS.md

AI contributor guide for this repository.

## Project Purpose

`oura-cf` is a Cloudflare Worker that ingests Oura API v2 data into D1 and serves Grafana-friendly APIs.

Primary ingestion path is webhook-first (`/webhook/oura`) with Queue processing. Cron + backfill workflow are fallback/reconciliation paths.

## Non-Negotiables

- OAuth-only auth model (PAT is removed).
- Do not protect `/webhook/oura` or `/oauth/callback` with Cloudflare Access.
- Keep admin routes protected by Access + `ADMIN_SECRET` bearer auth.
- Do not commit secrets (`.dev.vars` is local-only).
- Preserve schema compatibility unless doing an explicit migration.
- No hardcoded domains or account-specific values in source code. Use `wrangler.jsonc` vars or env vars instead.
- Do not add code comments unless explicitly asked.

## AI Session Workflow

- **Justify before implementing**: When suggesting changes, explain why it's worth doing and what the impact is. Do not start coding until the owner agrees.
- **Be honest about what's not worth doing**: If a suggested fix has minimal impact for this single-user system, say so explicitly and recommend skipping it. Don't pad the list with low-value work.
- **Deploy and verify incrementally**: Deploy after each logical batch of changes (not one at a time, not all at the end). Verify via live endpoint tests and/or observability after each deploy.
- **Verify security fixes against production**: Unit tests are necessary but not sufficient. After deploying security fixes (SQL injection, auth bypass, etc.), test them against the live endpoint using `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers from `.dev.vars`.
- **Keep configs in sync**: When `wrangler.jsonc` changes structurally (new bindings, removed fields, new vars), update `wrangler.starter.jsonc` in the same change.
- **Rank suggestions by severity**: Present findings as Critical / High / Medium / Low. Lead with what matters.

## Auth Model (Quick)

- Public endpoints: `/health`, `/favicon.ico`, `/oauth/callback`, `/webhook/oura`
- Bearer-protected endpoints: `/api/*`, `/backfill`, `/oauth/start`
- Admin-only bearer routes:
  - `/oauth/start`
  - `/backfill`
  - `/backfill/status`
  - `/api/admin/oura/webhooks*`

## Core Runtime Components

- Worker runtime: `src/index.ts`
- Database: D1 binding `oura_db`
- Cache: KV binding `OURA_CACHE`
- Queue: `OURA_WEBHOOK_QUEUE`
- Workflow: `BACKFILL_WORKFLOW`

## Required Secrets (Prod)

- `GRAFANA_SECRET`
- `ADMIN_SECRET`
- `OURA_CLIENT_ID`
- `OURA_CLIENT_SECRET`
- `OURA_WEBHOOK_CALLBACK_URL`
- `OURA_WEBHOOK_VERIFICATION_TOKEN`

Optional: `OURA_WEBHOOK_SIGNING_SECRET`, `OURA_WEBHOOK_ALLOWED_SKEW_SECONDS`, `OURA_WEBHOOK_DATA_TYPES`, `OURA_WEBHOOK_EVENT_TYPES`.

## Key Runtime Patterns

- **Token refresh deduplication**: `getOuraAccessToken` uses a shared promise (`tokenRefreshPromise`) to prevent concurrent refresh calls from racing.
- **Cron overlap protection**: `scheduled()` checks a `sync:cron_lock` KV key before starting; lock auto-expires after 2 hours.
- **D1 batch chunking**: All `db.batch()` calls go through `batchInChunks()` which chunks into groups of 100 statements.
- **SQL injection prevention**: `isReadOnlySql` strips SQLite identifier quotes (`"`, `` ` ``, `[`, `]`) before checking blocked table patterns.
- **Incremental heart rate stats**: `updateTableStats` uses scalar MIN/MAX subqueries + delta count instead of full `COUNT(*)`.
- **Webhook freshness tracking**: Logs `lagSeconds` (arrival time vs event timestamp) for each accepted webhook.

## Local/CI Commands

- Lint: `npm run lint`
- Tests: `npm run test:run`
- Deploy: `npm run deploy:cf` (wrangler deploy only)
- Migrate DB: `npm run db:migrate` (run separately when schema changes)

## Release Process

Use `npm version patch|minor|major` to bump version. `scripts/sync-version.sh` syncs app version into wrangler/vitest config.

For detailed procedures, use:

- `docs/RUNBOOK.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/ENVIRONMENT.md`
