# DECISIONS

Architecture decisions (ADR-lite).

## 2026-04: OAuth-only (remove PAT)

- Decision: Remove PAT fallback and require OAuth token lifecycle.
- Why: Oura deprecated PAT usage; OAuth is supported and safer for long-term operation.
- Impact: Re-auth may be required if token state breaks.

## 2026-04: Webhook-first ingestion + Queue

- Decision: Use `/webhook/oura` as primary freshness path and enqueue deliveries to `OURA_WEBHOOK_QUEUE`.
- Why: Lower API polling load, near-real-time updates, and decoupled ingestion reliability.
- Impact: More moving parts (webhook, queue, subscription ops).

## 2026-04: Keep cron + workflow fallback

- Decision: Keep cron sync and backfill workflow even after webhook rollout.
- Why: Reconciliation and resilience when webhooks are delayed/blocked.
- Impact: Slightly higher complexity, better recovery posture.

## 2026-04: Access split by endpoint type

- Decision: Keep `/webhook/oura` and `/oauth/callback` public; protect admin/API paths with Access + bearer auth.
- Why: Oura cannot send Access headers to webhook/callback endpoints.
- Impact: Requires careful path policy configuration.
