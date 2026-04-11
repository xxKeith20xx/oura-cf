# RUNBOOK

Operational runbook for `oura-cf`.

## Daily Checks

- Verify `/health` is `ok`.
- Verify Grafana panels load and recent timestamps advance.
- Spot-check webhook subscription count via `/api/admin/oura/webhooks`.

## Common Incidents

## 1) OAuth state broken (ingestion pauses)

Symptoms:

- Backfill/sync fails with OAuth token errors.
- Data freshness stalls.

Recovery:

1. Call `/oauth/start` with admin bearer auth (and Access headers if protected).
2. Complete Oura consent in browser.
3. Verify backfill works with a short run (`days=1`).

## 2) Webhook subscription drift/expiry

Symptoms:

- Fewer/no webhook deliveries, increasing data lag.

Recovery:

1. `GET /api/admin/oura/webhooks`
2. `POST /api/admin/oura/webhooks/sync`
3. `POST /api/admin/oura/webhooks/renew?days=14`

## 3) Webhook callback blocked

Symptoms:

- Oura subscription sync fails challenge with 403.

Recovery:

1. Check Cloudflare security events for `/webhook/oura`.
2. Ensure Access is not applied to `/webhook/oura`.
3. Add/adjust WAF allow/bypass for webhook path if needed.

## 4) Queue backlog / DLQ growth

Symptoms:

- Ingestion lag increases while webhooks are still arriving.

Recovery:

1. Check queue and DLQ depth.
2. Inspect worker logs for repeated fetch/token errors.
3. Fix root cause, then replay/reprocess as needed.

## Handy Commands

```bash
# health
curl https://<host>/health

# short backfill check
curl "https://<host>/backfill?days=1" \
  -H "Authorization: Bearer <ADMIN_SECRET>"

# webhook subscriptions
curl https://<host>/api/admin/oura/webhooks \
  -H "Authorization: Bearer <ADMIN_SECRET>"
```
