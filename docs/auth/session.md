# Session lifecycle contract

This document describes the persistence, expiration, and invalidation rules that
are owned by [src/auth/session.ts](src/auth/session.ts). The goal is to keep the
runtime behavior, tests, and maintenance guidance aligned.

## Persistence

A new session is created by `createSession(address)` and stored as a single row in
`sessions` with the following contract:

- the raw session token is generated client-side and never stored in the database;
- the database stores a SHA-256 hash of the token, not the token itself;
- the wallet address is normalized to lowercase before persistence;
- the row always carries two expiry timestamps:
  - `expiresAt`: the sliding TTL for the current token;
  - `absoluteExpiresAt`: the hard maximum lifetime for the token family.

The initial values are derived from the module configuration:

- `expiresAt = now + SESSION_TTL_MS`
- `absoluteExpiresAt = now + SESSION_MAX_TTL_MS`

## Expiration

A session is considered valid only when all of the following are true:

- the token hash exists in the database;
- the token has not been revoked or rotated out;
- `expiresAt` is still in the future;
- `absoluteExpiresAt` is still in the future; and
- the presented address matches the stored address (case-insensitive).

The sliding expiry behaves as follows:

- every successful `requireSession` call refreshes `expiresAt` by one TTL window;
- the refresh never moves `expiresAt` past `absoluteExpiresAt`;
- `absoluteExpiresAt` is immutable once the row is created and remains the hard cap.

The boundary is inclusive for the current moment:

- a request at exactly the expiry boundary is still accepted;
- a request after the boundary is rejected.

## Invalidation

A session becomes invalid when one of the following happens:

- `revokeSession(token)` marks the matching row as revoked;
- `revokeFamily(familyId)` marks every row in that family as revoked;
- `revokeAllSessionsForAddress(address)` marks every row for that wallet as revoked;
- `rotateSession(address, token)` marks the presented token as rotated and issues a replacement token;
- `rotateSession` treats a reused rotated or revoked token as a compromise signal and revokes the whole family.

Any revoked or rotated token is rejected by `requireSession`.

## Sweep behavior

`sweepExpiredSessions(now)` deletes rows whose sliding expiry, absolute expiry, or
revocation state indicates they are no longer active. This is the cleanup path for
expired or explicitly invalidated sessions.

## Compatibility and scope

This contract is intentionally scoped to the existing module and its current
callers. The public function signatures remain unchanged, and the behavior above
is covered by the session tests in [src/auth/session.test.ts](src/auth/session.test.ts).

## Edge cases intentionally out of scope

- exporting session metrics to Prometheus or OTLP;
- adding request-scoped correlation IDs to the session module;
- changing the public function signatures for existing callers.
