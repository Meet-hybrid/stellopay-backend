# Session Lifecycle Observability

This document describes the **observability contract** for `src/auth/session.ts`.
It pins down the structured logs and metric counters that every state
transition in the session lifecycle emits, so that SREs, dashboards, and
alerting rules can rely on a stable shape.

For the request-level access log, see `src/middleware/access-log.ts`. The
conventions in this file mirror that middleware: JSON output when
`LOG_FORMAT=json`, otherwise a single human-readable line.

## When to read this

- You are debugging session-related production failures and need to know
  which event names and counter names to grep for.
- You are writing a new caller of `createSession`, `requireSession`,
  `revokeSession`, `rotateSession`, `revokeFamily`,
  `revokeAllSessionsForAddress`, or `sweepExpiredSessions` and want to know
  what side effects to expect.
- You are adding a new session lifecycle event and need to keep the contract
  consistent.

---

## Lifecycle at a glance

```
               ┌─────────────┐
   /auth/verify│ createSession│
   ───────────▶│             │──▶ session.created (info)
               └──────┬──────┘    session_created_total += 1
                      │
                      ▼
   ┌──────────────────────────────────────┐
   │ requireSession / rotateSession      │  ← called on every authenticated request
   │                                      │
   │  valid ──▶ session.validated (debug)│
   │            session_validated_total  │
   │                                      │
   │  invalid ──▶ session.rejected (warn)│
   │              session_rejected_total  │
   │              + one of:               │
   │                session_rejected_unknown_token_total
   │                session_rejected_address_mismatch_total
   │                session_rejected_revoked_total
   │                session_rejected_expired_total
   │                                      │
   │  rotation OK ──▶ session.rotated     │
   │                  session_rotated_total│
   │                                      │
   │  reuse (rotated/revoked token seen)──▶ session.reuse_detected (warn)
   │                                       session_reuse_detected_total
   │                                       session.family_revoked (warn)
   │                                       session_family_revoked_total
   └──────────────────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────┐
   │ revokeSession / revokeFamily /       │
   │ revokeAllSessionsForAddress          │
   │   ──▶ session.revoked (info)        │
   │       session_revoked_total          │
   │   ──▶ session.family_revoked (warn) │
   │       session_family_revoked_total   │
   │   ──▶ session.all_revoked (info)    │
   │       session_all_revoked_total      │
   └──────────────────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────┐
   │ sweepExpiredSessions (every 10 min)  │
   │   ──▶ session.sweep_completed (info)│
   │       session_sweep_runs_total       │
   │       session_sweep_deleted_total    │
   │       session_sweeper_last_deleted_count (gauge)
   │       session_sweeper_last_run_at_ms  (gauge)
   │                                      │
   │   on DB error ──▶ session.sweep_failed (error)
   │                   session_sweeper_errors_total
   └──────────────────────────────────────┘
```

#### Sliding Expiration Write-Throttling
To minimize database write load during frequent API requests, `requireSession` implements write-throttling. The session's `lastSeen` and `expiresAt` timestamps are only updated in the database if the time elapsed since `lastSeen` is at least 1 minute (`60,000 ms`). Validations occurring within this 1-minute window return successfully without invoking write operations to the database.

### Token Rotation

#### Concurrency & Transaction Safety
Token rotation is executed within a database transaction using row-level locking (`FOR UPDATE` on the matched session). This guarantees that concurrent rotation requests do not result in race conditions, ensuring that compromise detection and family revocation behave deterministically.

#### Compromise Detection (Family Revocation)

---

## Structured log events

Every event is a single line. Format depends on `LOG_FORMAT`:

| `LOG_FORMAT`     | Output shape (per line)                                            |
| ---------------- | ------------------------------------------------------------------ |
| `json` (default) | `JSON.stringify({ timestamp, level, event, ...data })` to stdout   |
| anything else    | `[session] <ts> <LEVEL> <event> k1=v1 k2=v2 ...` to stdout         |

`LOG_LEVEL` (default `info`) filters by minimum severity. Levels, in
ascending verbosity: `error`, `warn`, `info`, `debug`.

| Event                     | Level | Emitted by                                  | Notable fields                                                                 |
| ------------------------- | ----- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `session.created`         | info  | `createSession` (success)                  | `address`, `expires_in_ms`, `absolute_expires_in_ms`                           |
| `session.validated`       | debug | `requireSession` (success)                 | `address`, `next_expires_at`                                                   |
| `session.rejected`        | warn  | `requireSession` / `rotateSession` (false) | `reason`, `address`                                                            |
| `session.rejected`        | error | `requireSession` (DB error) / `createSession` (DB error) | `reason="db_error"`, `operation` (`require` or `create`), `address`, `message` |
| `session.revoked`         | info  | `revokeSession`                            | `kind="single"`, `token_hash_prefix` (first 8 hex chars, never the raw token) |
| `session.rotated`         | info  | `rotateSession` (success)                  | `address`, `family_id`, `expires_in_ms`                                        |
| `session.reuse_detected`  | warn  | `rotateSession` (replay of stale token)    | `address`, `family_id`, `had_rotated_at`, `had_revoked_at`                     |
| `session.family_revoked`  | warn  | `revokeFamily` / reuse-detection path      | `family_id`                                                                    |
| `session.all_revoked`     | info  | `revokeAllSessionsForAddress`              | `address`                                                                      |
| `session.sweep_completed` | info  | `sweepExpiredSessions` (success)           | `deleted`, `now` (ISO timestamp)                                               |
| `session.sweep_failed`    | error | `sweepExpiredSessions` (DB error)          | `message`                                                                      |
| `session.sweeper_crashed` | error | background interval `.catch`               | `message`                                                                      |

### `session.rejected` reasons

The `reason` field is a **bounded enum** — never free-form text — so log
searches and dashboards stay predictable:

| Reason            | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `missing_input`   | `requireSession` called with empty `token` or empty `address`           |
| `unknown_token`   | Hash of the presented token does not match any row in `sessions`         |
| `address_mismatch`| Token is valid but was issued for a different wallet address            |
| `revoked`         | Row exists but `revokedAt` is set                                        |
| `expired_sliding` | `expiresAt` (sliding) is in the past                                     |
| `expired_absolute`| `absoluteExpiresAt` is in the past                                       |
| `db_error`        | DB query itself threw (network, constraint, etc.)                        |

---

## Metric counters

All metrics are **process-local**, monotonic counters (plus a small set of
gauges). They are exposed via `getSessionMetricsSnapshot()` from
`src/auth/session-metrics.ts` — for now, read them directly from a debug
endpoint or admin script. Wiring them into Prometheus / OTLP is intentionally
out of scope for this PR.

| Counter name                                  | Bumped by                                        |
| --------------------------------------------- | ------------------------------------------------ |
| `session_created_total`                       | `createSession` (success)                       |
| `session_validated_total`                     | `requireSession` returns `true`                  |
| `session_rejected_total`                      | Every `requireSession` / `rotateSession` non-`true` return path |
| `session_rejected_unknown_token_total`        | `reason="unknown_token"`                        |
| `session_rejected_address_mismatch_total`     | `reason="address_mismatch"`                     |
| `session_rejected_revoked_total`              | `reason="revoked"`                              |
| `session_rejected_expired_total`              | `reason="expired_sliding"` OR `reason="expired_absolute"` |
| `session_revoked_total`                       | `revokeSession` (non-empty token)               |
| `session_rotated_total`                       | `rotateSession` returns `{ ok: true, ... }`     |
| `session_reuse_detected_total`                | `rotateSession` saw a rotated/revoked token     |
| `session_family_revoked_total`                | `revokeFamily` (incl. the reuse-detection path) |
| `session_all_revoked_total`                   | `revokeAllSessionsForAddress`                   |
| `session_sweep_runs_total`                    | `sweepExpiredSessions` (success)                |
| `session_sweep_deleted_total`                 | `sweepExpiredSessions` (success), by `count`    |
| `session_sweeper_errors_total`                | `sweepExpiredSessions` DB error OR background `.catch` |

| Gauge name                              | Set by                                   |
| --------------------------------------- | ---------------------------------------- |
| `session_sweeper_last_deleted_count`    | `sweepExpiredSessions` (success)         |
| `session_sweeper_last_run_at_ms`        | `sweepExpiredSessions` (success)         |

### Cardinality

Counter names are fixed strings — no labels with attacker-controlled
values. The only "label-like" field is the bounded `reason` enum, which is
encoded as a separate counter per reason (e.g.
`session_rejected_unknown_token_total`) so any single dashboard panel
stays at a fixed, small cardinality.

---

## Security rules

These rules are enforced by code review and by the
"never logs raw session tokens" test in `src/auth/session.test.ts`:

1. **Raw session tokens are never logged.** Only the SHA-256 hash is
   computed internally, and even that is only ever surfaced as an 8-char
   prefix (`token_hash_prefix`) under `session.revoked`. If you need to
   correlate a log line with a token, look it up by `address` instead.
2. **No signatures, refresh tokens, or one-time nonces are ever logged.**
   `routes/auth.ts` already redacts `session_token` and `signature` from
   the request log; the same redaction applies here.
3. **Addresses are lower-cased and emitted as-is.** Starknet addresses are
   not personally identifying information on their own, but treat them as
   pseudonymous identifiers when correlating across logs.
4. **Family IDs are random UUIDs (`crypto.randomUUID()`)** and are
   safe to log.

---

## Reading the metrics in tests

`src/auth/session-metrics.ts` exports:

```ts
resetSessionMetrics(): void;
getSessionMetricsSnapshot(): { counters: Record<string, number>; gauges: Record<string, number> };
SESSION_METRICS: { /* counter-name constants */ };
SESSION_GAUGES: { /* gauge-name constants */ };
```

Tests should `resetSessionMetrics()` in `beforeEach` and assert on
`getSessionMetricsSnapshot().counters[name]`. See `src/auth/session.test.ts`
for examples.

---

## Edge cases intentionally out of scope

- **No Prometheus / OTLP exporter.** Metrics live in-process; exporting
  them is a separate concern.
- **No `request_id` correlation.** The session module is request-agnostic.
  Wrap calls from route handlers with a request-id if you need to
  correlate a session log line with an HTTP request.
- **No login-rate / brute-force counter.** Existing
  `src/middleware/rate-limit.ts` already protects the auth endpoints;
  session-level rate metrics are not added here.
- **No challenge-nonce observability.** `createChallenge`/`consumeChallenge`
  are in-memory and intentionally cheap; they are not part of this contract.
- **No late-discovery of an already-revoked session.** `requireSession`
  still distinguishes `revoked` vs `expired_sliding` in the log, but it
  does not bubble that distinction up to the caller — the public contract
  stays `boolean`.

---

## Compatibility

- All public function signatures are unchanged.
- All existing tests in `src/auth/session.test.ts` and
  `src/routes/auth.test.ts` pass without modification.
- The background `setInterval` still runs only when `NODE_ENV !== "test"`.
- The behaviour of `requireSession`, `revokeSession`, `rotateSession`,
  `revokeFamily`, `revokeAllSessionsForAddress`, and `sweepExpiredSessions`
  is identical to the prior version; this PR only adds side channels.
