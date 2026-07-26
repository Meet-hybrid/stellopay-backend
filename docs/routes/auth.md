# `/api/v1/auth/*` — contract reference

This document is the executable counterpart to the TSDoc on the route handlers in `src/routes/auth.ts`. If the two ever disagree, the TSDoc wins for line-level details and this document wins for design intent and the idempotency contract.

## Surface

All endpoints live under `/api/v1/auth/*`. All POST endpoints accept a JSON body and respond with JSON.

| Method | Path                         | Auth required | Idempotent on retry? | Body shape (Zod)                                              |
| ------ | ---------------------------- | ------------- | -------------------- | ------------------------------------------------------------- |
| POST   | `/auth/challenge`            | no            | **yes (within TTL)** | `{ address: string (≥3 chars) }`                              |
| POST   | `/auth/verify`               | no            | yes (terminal)       | `{ address, signature: string[] (≥2) }`                       |
| POST   | `/auth/session/validate`     | no            | yes (read-only)      | `{ address, session_token: string (≥10) }`                    |
| POST   | `/auth/refresh`              | no            | deterministic / input-bound | `{ address, refresh_token: string (≥10) }`              |
| POST   | `/auth/logout`               | yes (`requireAuth`) | on the wire, no  | (no body)                                                     |
| POST   | `/auth/revoke`               | yes (`requireAuth`) | on the wire, no  | (no body)                                                     |

## Per-endpoint contract

### POST `/auth/challenge`

**Idempotent on retry within the TTL window.** `createChallenge` in `src/auth/challenge.ts` checks for an active record before generating a fresh one. A duplicate call:

- returns the SAME nonce (no fresh `challenge_created` metric; one `challenge_replayed` instead);
- does NOT push the TTL forward — `expires_in_ms` decreases as time passes;
- returns the same `typed_data` payload.

A retry **after** the TTL has elapsed returns a fresh nonce and a fresh 5-minute window. A retry **after** the nonce has been consumed (i.e. verify succeeded) also returns a fresh nonce — the slot is reusable.

**Failure shape:** the route responds with `400 { "error": "<Zod issue message>" }` for malformed addresses, and `500` (via the global error handler) for any unexpected exception. There is no rate limiting at this layer; the global rate limiter (`src/middleware/rate-limit.ts`) handles traffic shaping.

### POST `/auth/verify`

**Idempotent on the wire, terminal in semantics.** Each call MUST consume the active challenge atomically (via `consumeChallenge` in `src/auth/challenge.ts`) before the async signature check. Two concurrent calls with the same challenge resolve to exactly one `200` (and one new session row) and one `400 { "error": "No active challenge (or expired). Call /auth/challenge again." }`. Sequential retries after a successful verify resolve to `400` because the challenge is gone.

This is the property the prior replay test pins down: even if a client retries a successful `200` blindly, no second session row is created and no second signed nonce is exposed. Session issuance is therefore safe under retry.

**Failure shape:**
- `400 { "error": "No active challenge (or expired). Call /auth/challenge again." }` if the challenge is missing, expired, or already consumed.
- `401 { "error": "Invalid signature" }` if `provider.verifyMessageInStarknet` returns false.
- `500` for any unexpected exception.

### POST `/auth/session/validate`

**Idempotent on retry; read-only.** This endpoint does not consume or rotate the session; it returns `200 { ok: true, address }` for as long as the session is valid, or `401 { ok: false, error: "Invalid session" }` once it has expired, been revoked, or been rotated out.

The repo's test suite calls it three times consecutively against the same token and asserts all three succeed.

### POST `/auth/refresh`

**Deterministic per input token; not strictly idempotent across rotations.** Each call rotates the presented refresh token: the old token is marked rotated, a new token is issued in the same family, and a successful response returns `{ ok: true, address, refresh_token, expires_in_ms }`. Replaying the now-stale token results in `401` (and revokes the whole token family — a token-theft signal, see `rotateSession` in `src/auth/session.ts`).

This is the right semantics for a refresh endpoint: retries must NOT silently return the same token, because doing so would defeat rotation as a compromise-detection mechanism. If you want strict idempotency here, you need `Idempotency-Key` header support — not added in this PR.

### POST `/auth/logout`

**Idempotent on the wire only when the session is still valid.** A first call returns `200 { ok: true }` and revokes the session row. A second call with the same (now-revoked) token fails `requireAuth` (because the session is no longer valid) and returns the same generic `401 { "error": "Unauthorized" }` envelope as any other unauthorized call. The two responses are deliberately indistinguishable to a probe.

`requireAuth` is wired first in the chain, so any malformed header / unknown-token / revoked-token / expired-token case collapses to the same `401` body — there is no need for an explicit "session already revoked" code path.

### POST `/auth/revoke`

Same envelope semantics as `/auth/logout`: a valid session yields `200`, an already-revoked session yields the generic `401`. Both forms are documented as "safe under retry" — a client retry does not produce a different row state, and the revoke endpoint is itself idempotent in its effect on the database (`UPDATE … SET revokedAt = NOW()` over already-revoked rows is a no-op).

## Why `Idempotency-Key` is NOT wired here

The billing router (`src/routes/billing.ts`) already implements an `Idempotency-Key` cache via `withBillingIdempotency`. That pattern fits billing because billing endpoints mutate profile state and are routinely called from frontends that retry on network timeouts.

The `/auth/*` endpoints do NOT need that layer because:

- `/auth/challenge` is naturally idempotent via the challenge Map (see above).
- `/auth/verify` is naturally single-shot via `consumeChallenge`.
- `/auth/session/validate` is read-only.
- `/auth/refresh`, `/auth/logout`, `/auth/revoke` are guarded by `requireAuth` and the session lifecycle, so a retry either succeeds deterministically or fails closed.

Adding `Idempotency-Key` here would duplicate natural idempotency and complicate the failure envelope without changing outcomes. It is intentionally out of scope.

## Out of scope (intentional non-goals)

- **`Idempotency-Key` caching on `/auth/challenge` / `/auth/verify` / `/auth/refresh`.** See above.
- **Cross-instance challenge replication.** A challenge issued by instance A is not visible to instance B. See `docs/auth/challenge.md`.
- **Returning a different status code for "already revoked" on logout/revoke.** The generic `401` envelope is intentional; do not leak the distinction.
- **Logging the body of `/auth/verify`.** The route-level debug logger redacts `session_token` and `signature`; do not weaken that.
- **Adding rate-limit headers to `/auth/challenge`.** Rate limits live in `src/middleware/rate-limit.ts`, not here.

## Change management

When changing anything in this file or `src/routes/auth.ts`:

1. The wire envelopes above stay the same on every non-success path. Do not introduce new error codes.
2. The "Idempotent on retry?" column of the surface table is the source of truth for the contract. If you add a new endpoint, decide on its row before merging.
3. `pnpm test`, `pnpm lint`, and `pnpm build` all pass before opening a PR.
4. If you change any telemetry metric name (`challenge_*`, etc.), grep for the literal name across `src/` and update both code and tests in the same commit.