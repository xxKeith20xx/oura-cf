# RELEASE CHECKLIST

## 1. Pre-Release Checks

- [ ] `npm run check` (lint + format + tests)
- [ ] All tests pass, including the health endpoint version assertion (reads from `package.json` automatically)
- [ ] Migration files reviewed (if any)
- [ ] Dashboard JSON validated (if changed)

## 2. Update CHANGELOG.md

- [ ] Add new `## [x.y.z] - YYYY-MM-DD` entry at the top
- [ ] Categorize under Security / Fixed / Added / Changed / Removed / Documentation
- [ ] The release workflow reads CHANGELOG.md to build the GitHub Release body — it must exist before the tag is pushed

## 3. Version Bump

- [ ] `npm version patch|minor|major`
  - This automatically:
    1. Bumps `package.json` version
    2. Runs `scripts/sync-version.sh` which updates `wrangler.jsonc`, `wrangler.starter.jsonc`, `vitest.config.mts`
    3. Auto-stages those 3 files via the `version` npm script
    4. Creates a git commit (`x.y.z`) and tag (`vx.y.z`)
- [ ] Verify the commit includes all version-carrying files:
  - `package.json`
  - `wrangler.jsonc`
  - `wrangler.starter.jsonc`
  - `vitest.config.mts`

## 4. Deploy

- [ ] `npm run deploy:cf`
- [ ] Verify `/health` returns the new version
- [ ] Verify `/api/stats` and `/api/sql`
- [ ] Verify webhook subscriptions (`/api/admin/oura/webhooks`)

## 5. Push & Publish

- [ ] `git push && git push --tags`
  - The `v2*` tag triggers the **Create Release** GitHub Action automatically
  - The action extracts the matching CHANGELOG section for the release body
  - If the version is missing from CHANGELOG.md, a fallback body is used instead of failing
- [ ] Verify the GitHub Release was created at https://github.com/xxKeith20xx/oura-cf/releases

## Troubleshooting

- **Code Quality Checks failing on version mismatch**: The health endpoint test reads version from `package.json` via `import { version } from '../package.json'`. If this fails, the `package.json` version is out of sync with `wrangler.jsonc` / `vitest.config.mts`. Re-run `scripts/sync-version.sh`.
- **Create Release workflow failing**: Only `v2*.*.*` tags trigger the release workflow. Old `v1.x` tags are ignored. If the changelog step can't find the version, it produces a minimal release instead of failing.
