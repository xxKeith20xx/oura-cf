#!/bin/bash
# Runs PRAGMA optimize on the D1 database to update query planner statistics.
# Should be run after applying any migration that adds or drops indexes.
# See: https://developers.cloudflare.com/d1/best-practices/use-indexes/
set -euo pipefail

REMOTE="${1:-}"

if [ "$REMOTE" = "--remote" ]; then
    echo "Running PRAGMA optimize on remote database..."
    npx wrangler d1 execute oura-db --remote --command "PRAGMA optimize;"
else
    echo "Running PRAGMA optimize on local database..."
    npx wrangler d1 execute oura-db --local --command "PRAGMA optimize;"
    echo ""
    echo "To run against the remote (production) database, pass --remote:"
    echo "  ./scripts/optimize-db.sh --remote"
fi
