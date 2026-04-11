# KNOWN ISSUES

## Webhook delete events

- Current queue processor acks `delete` webhook events without deleting historical rows from D1.
- Impact: deleted upstream records may remain visible unless overwritten by later sync patterns.

## OAuth re-consent is manual

- If OAuth token state is revoked/broken, a human must re-run `/oauth/start` and approve consent.
- This is expected behavior for OAuth authorization flows.

## Access/WAF misconfiguration can block webhook challenge

- If `/webhook/oura` is protected or blocked, webhook sync can fail with challenge 403.
- Ensure webhook path is publicly reachable.
