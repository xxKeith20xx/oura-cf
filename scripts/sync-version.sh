#!/bin/bash
# Syncs the version from package.json into wrangler.jsonc and vitest.config.mts.
# Run automatically via the "version" npm lifecycle hook (triggered by npm version patch/minor/major).
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")

# Update wrangler.jsonc define block
sed -i '' "s/\"__APP_VERSION__\": \"\\\\\"[^\"]*\\\\\"\"/\"__APP_VERSION__\": \"\\\\\"${VERSION}\\\\\"\"/" wrangler.jsonc

# Update vitest.config.mts
sed -i '' "s/__APP_VERSION__: JSON.stringify('[^']*')/__APP_VERSION__: JSON.stringify('${VERSION}')/" vitest.config.mts

echo "Version synced to ${VERSION} in wrangler.jsonc and vitest.config.mts"
