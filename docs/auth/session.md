# Session Management

This document describes the session lifecycle for the Stellopay backend.

## Session Lifecycle

Sessions are managed in `src/auth/session.ts`. A session token is an opaque 24-byte hex string. The token itself is never stored in the database. Instead, a SHA-256 hash of the token is stored, protecting active sessions in case of database compromise.

### Session Persistence

When a session is created using `createSession(address)`, a token is generated, hashed, and stored in the database along with its:
- `familyId`: Used for token rotation to group chained refresh tokens together.
- `expiresAt`: The time at which the session expires if no further activity occurs.
- `absoluteExpiresAt`: A hard limit on how long the session can remain valid, even if actively used.

### Session Invalidation & Expiration

A session becomes invalid if any of the following conditions are met when evaluated by `requireSession(address, token)`:
- It does not exist in the database (or the address doesn't match).
- The `expiresAt` timestamp has been passed (sliding expiration).
- The `absoluteExpiresAt` timestamp has been passed (absolute expiration limit).
- The session has been explicitly revoked (`revokedAt !== null`).
- The token has been rotated (`rotatedAt !== null`). This is a key safety boundary: a token that has been rotated can no longer be used for standard session operations.

### Token Rotation

We support rotating refresh tokens (`rotateSession(address, token)`) which provides a new token while retaining the original session's `absoluteExpiresAt` bounds and `familyId`. The original token is marked as rotated (`rotatedAt = now`).

#### Compromise Detection (Family Revocation)

If a token that has already been rotated (or revoked) is presented to `rotateSession`, it is a strong signal of a replay attack or token compromise. When this occurs, the entire token family (identified by `familyId`) is immediately revoked via `revokeFamily(familyId)`, locking out all active sessions within that chain.

### Background Sweep

A periodic background sweeper (`sweepExpiredSessions`) runs to purge expired or revoked sessions from the database, preventing indefinite growth. This strictly cleans up entries that have crossed `expiresAt`, `absoluteExpiresAt`, or have been explicitly revoked. Rotated tokens that have not yet expired remain in the database for the rest of their natural TTL to ensure compromise detection (family revocation) remains functional.

## Important Note

The contract is maintained inside `src/auth/session.ts` and guaranteed by comprehensive tests in `src/auth/session.test.ts`. Any new behavior added to session persistence, expiration, rotation, or invalidation must be mirrored across this documentation, the runtime code, and the regression tests.
