#!/bin/bash
# Syncs the version from package.json into wrangler configs and vitest.config.mts.
# Run automatically via the "version" npm lifecycle hook (triggered by npm version patch/minor/major).
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")

# Update wrangler.jsonc define block
sed -i '' "s/\"__APP_VERSION__\": \"\\\\\"[^\"]*\\\\\"\"/\"__APP_VERSION__\": \"\\\\\"${VERSION}\\\\\"\"/" wrangler.jsonc

# Update starter config (if present)
if [ -f "wrangler.starter.jsonc" ]; then
	sed -i '' "s/\"__APP_VERSION__\": \"\\\\\"[^\"]*\\\\\"\"/\"__APP_VERSION__\": \"\\\\\"${VERSION}\\\\\"\"/" wrangler.starter.jsonc
fi

# Update vitest.config.mts
sed -i '' "s/__APP_VERSION__: JSON.stringify('[^']*')/__APP_VERSION__: JSON.stringify('${VERSION}')/" vitest.config.mts

echo "Version synced to ${VERSION} in wrangler.jsonc, wrangler.starter.jsonc, and vitest.config.mts"
