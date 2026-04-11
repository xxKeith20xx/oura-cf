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

## Local/CI Commands

- Lint: `npm run lint`
- Tests: `npm run test:run`
- Deploy (maintainer): `npm run deploy:cf`

## Release Process

Use `npm version patch|minor|major` to bump version. `scripts/sync-version.sh` syncs app version into wrangler/vitest config.

For detailed procedures, use:

- `docs/RUNBOOK.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/ENVIRONMENT.md`
