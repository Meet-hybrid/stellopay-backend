# Event Reprocessing Routes

Base path: `/api/v1/reprocess-events`

All three routes require the caller to be authenticated (`requireAuth`) and
hold an admin role (`requireAdmin`). Unauthenticated or non-admin requests
receive a `401` before any of the logic below runs (this app's admin check
returns `401`, not `403`, to avoid confirming a valid-but-unprivileged
address to an attacker).

This contract is enforced by two dedicated test layers, not just this
paragraph: `reprocess-events.middleware.test.ts` asserts the Express
middleware stack itself includes `requireAuth` then `requireAdmin` on every
route, and `reprocess-events.auth.test.ts` exercises the real middleware
end-to-end (no credentials, non-admin address, invalid token, and valid
admin — see Issue #273). A future change that drops or reorders either
middleware on any route will fail one of these tests before it can reach
production.

## `POST /reprocess-events/tx/:tx_hash`

Reprocess a single transaction's events to (re)decode their event names.

- **Params**: `:tx_hash` — a Starknet transaction hash (0x-prefixed, 3–66
  hex characters).
  - **Response** `200`:
    ```json
      { "message": "Events reprocessed", "result": { "txHash": "...", "status": "processed", "eventsProcessed": 1, "eventLabels": ["AgreementCreated-123"], "tokenVerified": true } }