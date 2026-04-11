# ENVIRONMENT

Bindings, secrets, and expected defaults.

## Cloudflare Bindings

- D1: `oura_db`
- KV: `OURA_CACHE`
- Queue producer/consumer: `OURA_WEBHOOK_QUEUE`
- Workflow: `BACKFILL_WORKFLOW`
- Optional analytics: `OURA_ANALYTICS`
- Rate limiters: `RATE_LIMITER`, `AUTH_RATE_LIMITER`, `UNAUTH_RATE_LIMITER`

## Required Secrets

- `GRAFANA_SECRET`
- `ADMIN_SECRET`
- `OURA_CLIENT_ID`
- `OURA_CLIENT_SECRET`
- `OURA_WEBHOOK_CALLBACK_URL`
- `OURA_WEBHOOK_VERIFICATION_TOKEN`

## Optional Secrets / Vars

- `OURA_WEBHOOK_SIGNING_SECRET` (defaults to `OURA_CLIENT_SECRET` if unset)
- `OURA_WEBHOOK_ALLOWED_SKEW_SECONDS` (default `300`)
- `OURA_WEBHOOK_DATA_TYPES` (default built-in list)
- `OURA_WEBHOOK_EVENT_TYPES` (default `create,update,delete`)
- `ALLOWED_ORIGINS`
- `MAX_QUERY_ROWS` (default `50000`)
- `QUERY_TIMEOUT_MS` (default `7000`)
- `LOG_SQL_PREVIEW` (set `false` in prod for less sensitive logs)

## Access Path Policy

Protected:

- `/api/*`
- `/backfill`
- `/oauth/start`

Public:

- `/webhook/oura`
- `/oauth/callback`
- `/health`
- `/favicon.ico`
