# Backfill script

```bash
for offset in $(seq 0 14 1094); do
  echo "Backfilling offset $offset..."
  curl -s -X POST "https://oura-cf.keith20.workers.dev/backfill?days=14&offset_days=$offset" \
    -H "Authorization: Bearer redacted"
  echo ""
  sleep 3
done
```

# High-level outline (shareable)

- **Goal**
  - Ingest *all* Oura v2 usercollection data into a queryable store
  - Provide a secure, read-only API for analytics tools (Grafana Cloud)
  - Build a comprehensive Grafana dashboard with useful visualizations + insights

- **Architecture**
  - **Cloudflare Worker** = ingestion orchestrator + API surface
  - **Cloudflare D1** = storage (raw JSON + curated tables)
  - **Oura API v2 OAuth2** = authorization + refresh tokens
  - **Grafana Cloud + Infinity plugin** = dashboarding via HTTP POST to `/api/sql`

- **Key features**
  - Dynamic ingestion of Oura endpoints from the Oura **OpenAPI spec**
  - Historical backfill with **chunking + resource filtering** to avoid Worker timeouts
  - A hardened `/api/sql` endpoint for Grafana (read-only SQL validation + auth)
  - A dashboard covering scores, sleep, activity, HR/HRV, workouts, stress, and insights

---

# Project steps taken (end-to-end)

## 1) Set up the Worker + D1 database
- **Created/confirmed D1 binding** (`oura_db`) in [wrangler.jsonc])
- **Added D1 migrations** under `migrations/` to create:
  - `oura_raw_documents` table (raw JSON payload storage)
  - OAuth token/state tables for Oura OAuth flow
  - Some curated tables to support cleaner analytics over time

**Idea:** D1 gives you a lightweight SQL database that’s cheap, fast, and easy to query from Grafana.

---

## 2) Implement Oura OAuth2 authorization + token refresh
- Added endpoints:
  - `GET /oauth/start` to initiate Oura OAuth flow
  - `GET /oauth/callback` to exchange auth code for tokens
- Stored tokens in D1 and implemented **automatic refresh** for ingestion requests
- Ensured callback `state` is stored server-side and **expires** (prevents CSRF/state replay)

**Idea:** Keep long-lived credentials out of Grafana and out of the browser; the Worker becomes the trusted server-side integration.

---

## 3) Build ingestion that covers “everything” in Oura v2
- Instead of hardcoding endpoint lists, ingestion loads the Oura **OpenAPI spec** and iterates all `/v2/usercollection/*` GET endpoints that:
  - don’t require path params (skips `/.../{id}` style endpoints)
  - support paging via `next_token` when available
- For each endpoint, ingestion:
  - builds the correct query params (`start_date/end_date` or datetime range)
  - paginates
  - stores raw records into `oura_raw_documents`
  - optionally populates curated tables

**Idea:** “Spec-driven ingestion” means you don’t have to manually update code when Oura adds new endpoints.

---

## 4) Fix missing timestamps / coverage issues in stored data
- Implemented robust extraction of:
  - `day`
  - `start_at`
  - `end_at`
- Sleep/workout-style payloads often have different timestamp fields (e.g. bedtime_*), so extraction logic had to be defensive.

**Idea:** Having consistent `day/start_at/end_at` enables reliable time-series queries and makes it obvious what date ranges exist per resource.

---

## 5) Make historical backfill reliable (avoid Worker timeouts)
- Implemented `/backfill` endpoint with:
  - `days=<N>` (how much to backfill)
  - `offset_days=<N>` (shift window backward to walk back in time)
  - `resources=a,b,c` (limit which endpoints to ingest per request)
- Implemented per-resource chunk sizes (e.g. `heartrate` has tighter date constraints).
- Recommended running backfill in **chunks** (e.g. 60–90 days at a time) with delays between requests.

**Idea:** Cloudflare Workers have execution limits; backfill must be incremental and resumable.

---

## 6) Expose a secure read-only SQL API for Grafana
- Implemented `POST /api/sql` with body format:

```json
{ "sql": "SELECT ...", "params": [] }
```

- Secured it with a bearer token (e.g. `Authorization: Bearer <GRAFANA_SECRET>`)
- Added read-only enforcement ([isReadOnlySql]) and blocked access to sensitive tables (OAuth token tables)
- Added CORS handling for Grafana plugin use

**Idea:** Grafana can query anything once it has SQL—so you must enforce read-only + auth, and ideally restrict tables further.

---

## 7) Configure Grafana Cloud + Infinity datasource
- Set up Infinity datasource to:
  - POST to `https://oura-cf.keith20.workers.dev/api/sql`
  - Include `Authorization: Bearer <token>`
- Resolved Infinity security setting: host allowlist needs the **full scheme + host** (e.g. `https://.../`).

**Idea:** Infinity becomes a lightweight HTTP-to-table adapter; D1 is your analytics store.

---

## 8) Build the Grafana dashboards
- Started with a “core” dashboard (scores + sleep + activity + workouts + coverage)
- Then created a larger “full” dashboard:
  - [grafana-dashboard-full.json]
  - Uses consistent `time` columns for time-series panels to avoid Grafana errors like **“Data is missing a time field”**
- Adjusted panels to pull metrics from the correct resource:
  - many physiology metrics are in `sleep` (session resource), not `daily_sleep`
  - implemented `COALESCE` + daily aggregation of sessions where needed

**Idea:** Oura has multiple representations (daily summaries vs sessions). Dashboards need to query the correct one or combine them.

---

## 9) Security review (public repo + attacker model)
- Ensured secrets are not committed (keep them as Cloudflare Worker secrets)
- Identified main risks:
  - token leakage → data exfiltration via `/api/sql`
  - expensive SQL → DoS/cost issues
- Discussed hardening approaches:
  - Cloudflare Access service tokens (especially good with Grafana Cloud)
  - split “read token” vs “admin token”
  - stronger SQL/table allowlists and rate limiting (in-worker or via CF controls)

**Idea:** Treat `/api/sql` like a database endpoint on the public internet—lock it down like you would any data API.

---

# What to share as “results”
- **Running Worker endpoint:** `https://oura-cf.keith20.workers.dev`
- **Key APIs:**
  - `POST /api/sql` (Grafana read access)
  - `GET /backfill?days=...&offset_days=...&resources=...` (controlled ingestion)
  - `/oauth/start` + `/oauth/callback` (Oura OAuth)
- **Outputs:**
  - D1 populated with multi-year Oura history
  - Grafana dashboards with trends + insights + coverage checks

---

# Current status / next steps
- **In progress**
  - Backfill completion and validating min/max coverage for each resource
  - Decision: keep `workers.dev` + Access vs move to custom domain for richer WAF controls
- **Next recommended step**
  - Run/verify a “coverage query” panel (already included) until all resources show expected date ranges

**Status:** Outline + steps written for sharing. Backfill and hardening decision remain ongoing.
