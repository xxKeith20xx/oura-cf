# RELEASE CHECKLIST

## Pre-Release

- [ ] `npm run lint`
- [ ] `npm run test:run`
- [ ] README and changelog updated
- [ ] Migration files reviewed (if any)
- [ ] Dashboard changes validated (if JSON changed)

## Versioning

- [ ] Run `npm version patch|minor|major`
- [ ] Confirm `scripts/sync-version.sh` updated:
  - `wrangler.jsonc`
  - `wrangler.starter.jsonc`
  - `vitest.config.mts`

## Deploy

- [ ] `npm run deploy:cf` (maintainer) or `wrangler deploy --config ...`
- [ ] Verify `/health`
- [ ] Verify `/api/stats` and `/api/sql`

## Post-Deploy

- [ ] Verify webhook subscriptions (`/api/admin/oura/webhooks`)
- [ ] Run sync/renew if needed
- [ ] Verify Grafana freshness panels

## Publish

- [ ] Commit release changes
- [ ] Push branch
- [ ] Create GitHub release tag + notes
