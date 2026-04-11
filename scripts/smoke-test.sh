#!/bin/bash
set -euo pipefail

HOST="${HOST:-}"
GRAFANA_SECRET="${GRAFANA_SECRET:-}"
ADMIN_SECRET="${ADMIN_SECRET:-}"
CF_ACCESS_CLIENT_ID="${CF_ACCESS_CLIENT_ID:-}"
CF_ACCESS_CLIENT_SECRET="${CF_ACCESS_CLIENT_SECRET:-}"

if [ -z "$HOST" ]; then
	printf "HOST is required. Example: HOST=https://oura.keith20.dev\n" >&2
	exit 1
fi

COMMON_HEADERS=()
if [ -n "$CF_ACCESS_CLIENT_ID" ] && [ -n "$CF_ACCESS_CLIENT_SECRET" ]; then
	COMMON_HEADERS+=( -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" )
	COMMON_HEADERS+=( -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" )
fi

echo "[1/5] Health"
curl -fsS "$HOST/health" >/dev/null

if [ -n "$GRAFANA_SECRET" ]; then
	echo "[2/5] API stats (grafana token)"
	curl -fsS "$HOST/api/stats" "${COMMON_HEADERS[@]}" -H "Authorization: Bearer $GRAFANA_SECRET" >/dev/null

	echo "[3/5] API SQL smoke (grafana token)"
	curl -fsS "$HOST/api/sql" "${COMMON_HEADERS[@]}" \
		-H "Content-Type: application/json" \
		-H "Authorization: Bearer $GRAFANA_SECRET" \
		--data '{"sql":"SELECT COUNT(*) AS value FROM daily_summaries","params":[]}' >/dev/null
else
	echo "[2-3/5] Skipped grafana-token checks (GRAFANA_SECRET not set)"
fi

if [ -n "$ADMIN_SECRET" ]; then
	echo "[4/5] Admin webhooks list"
	curl -fsS "$HOST/api/admin/oura/webhooks" "${COMMON_HEADERS[@]}" -H "Authorization: Bearer $ADMIN_SECRET" >/dev/null

	echo "[5/5] Backfill status endpoint sanity"
	curl -fsS "$HOST/backfill/status" "${COMMON_HEADERS[@]}" -H "Authorization: Bearer $ADMIN_SECRET" >/dev/null || true
else
	echo "[4-5/5] Skipped admin checks (ADMIN_SECRET not set)"
fi

echo "Smoke test complete."
