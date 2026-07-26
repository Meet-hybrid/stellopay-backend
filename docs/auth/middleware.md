# `src/auth/middleware.ts` — contract reference

This document is the executable counterpart to the TSDoc on
`requireAuth` and `requireAdmin` in `src/auth/middleware.ts`. If the two
ever disagree, the TSDoc wins for line-level details and this document wins
for design intent and out-of-scope decisions.

## Purpose

`src/auth/middleware.ts` is the only place in this service that turns raw
HTTP request headers into a typed principal (`req.auth`). Every route that
ever calls `req.auth.*` — `/auth/*`, `/events/process_batch`,
`/events/process_tx/:tx_hash`, `/diagnostics/*`,
`/admin/backfill-events/*`, `/admin/reprocess-events/*` and others —
wires `requireAuth` directly; the admin-scoped routes additionally pipe
through `requireAdmin`.

The two exports are:

- `requireAuth(req, res, next)` — validates a session and attaches
  `req.auth = { address, token }` on success.
- `requireAdmin(req, res, next)` — checks the principal against the
  `ADMIN_ADDRESSES` env allow-list.

## The single-principal invariant (and why this middleware does not paginate or batch)

The hard contract on this file is **exactly one principal per HTTP request**:

- `req.auth` is a single object, never an array, never a cursor, never a
  page.
- `requireAuth` reads `x-user-address` and `Authorization` as
  `string | string[] | undefined` per Express types, but — via
  `readSingleHeader` — narrows them to a single non-empty trimmed `string`
  or rejects with `401`. A multi-valued `x-user-address` (which would mean
  "two principals in one request") is **rejected**, never partially accepted.
- `requireAdmin` likewise operates on a single normalized address. There is
  intentionally no `requireAdminForMany` variant.

So while the rest of the codebase does paginate and batch — every list
endpoint uses `parsePagination` from `src/utils/validation.ts` with
`MAX_PAGE_LIMIT = 100` / `DEFAULT_PAGE_LIMIT = 50`, and the batch endpoints
in `src/routes/transactions.ts`, `src/routes/events.ts`, and
`src/routes/read.ts` cap batch sizes (e.g. `MAX_BATCH_SIZE = 50`) — those
contracts live at the **route** layer, where one authenticated principal
can drive batch operations across many on-chain entities. Batch resolution of
principals themselves belongs to a different design conversation and is
**out of scope** for this middleware.

Anything that would force us to break the single-principal invariant is,
by definition, not a change to this file.

## Input contract for `requireAuth`

Both headers are required, both must be a single non-empty trimmed string,
and `Authorization` must be a Bearer token.

| Header             | Required | Accepted shape                                      | On any other shape |
| ------------------ | -------- | --------------------------------------------------- | ------------------ |
| `x-user-address`   | yes      | single string, trimmed, non-empty                   | `401 Unauthorized` |
| `Authorization`    | yes      | `Bearer <token>` — prefix is `Bearer ` (case-sensitive, single space); trailing whitespace is trimmed; token must be non-empty after trim | `401 Unauthorized` |
| Other headers      | ignored  | —                                                   | —                  |

Edge cases that the middleware explicitly handles today, so the runtime
path, tests, and docs agree:

- `x-user-address: ["0xa", "0xb"]` — multi-valued array → `401`. This is
  the contract, not a bug. The middleware resolves one principal and will
  not pick the first or join them.
- `x-user-address: "   "` or `""` — empty / whitespace-only → `401`.
- `Authorization: ["Bearer a", "Bearer b"]` — multi-valued → `401`.
- `Authorization: "Basic abc"` — wrong scheme → `401`.
- `Authorization: "bearer abc"` — case-sensitive `Bearer ` → `401`.
- `Authorization: "Bearer "` or `Authorization: "Bearer    "` — empty
  token after the prefix → `401`.
- `x-user-address: "  0xUser  "` and `Authorization: "Bearer   abc   "`
  are accepted: addresses are normalized to `0xuser`, tokens to `abc`.

The trailing-trim after the prefix is intentional: real-world SDKs and curl
pipelines occasionally double-space the credential. We accept that and
normalize downstream.

## Output contract for `requireAuth`

On success, `requireAuth` attaches:

```ts
req.auth = { address: string /* trimmed + lower-cased */, token: string }
```

`req.auth.address` is the only form downstream code should compare against
session rows or admin allow-lists. `requireSession` in
`src/auth/session.ts` independently lower-cases for its DB lookup, so
internal log lines and the row key line up with what `req.auth.address`
holds.

`requireAuth` does **not** mutate `req.headers`, does **not** set any other
field on `req`, and does **not** read request bodies or query strings.

## Failure contract

Every failure path returns:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{ "error": "Unauthorized" }
```

The status code is `401` for **every** reason — not `403`, not `400`, not
`502`. This is deliberate: it means a client probe cannot distinguish
"unknown token" from "expired token" from "DB outage during session
lookup" from "wrong address casing". The granular reason is emitted by
`requireSession` into `session.rejected` log lines and the matching
metric counters (`session_rejected_total`,
`session_rejected_unknown_total`, etc.); those are operator-only signals.

`requireAuth` further wraps `requireSession` in a `try/catch` so an
unexpected throw (e.g. a `TypeError` from a future refactor) is also
collapsed to `401`, not surfaced as `500`. This was the pre-existing
behavior; the tests pin it down explicitly so it cannot regress.

## `requireAdmin` — ordering and defensive shape

`requireAdmin` MUST be chained **after** `requireAuth`. The assumption is
that `req.auth` is already populated and `req.auth.address` is the
normalized (trimmed, lower-cased) form. Every existing wired chain in this
repo (see `src/routes/diagnostics.ts`, `src/routes/backfill-events.ts`,
`src/routes/reprocess-events.ts`) follows that ordering, and the tests on
backfill/reprocess-events already mock `requireAuth` to set up `req.auth`
before `requireAdmin` runs.

Even if a future chain forgets the ordering, `requireAdmin` is hardened:

- `req.auth` must be truthy with a non-empty string `address`. Otherwise
  `401`.
- `req.auth.address` is independently lower-cased at lookup, as
  defense-in-depth, so a `req.auth` produced by hand without normalization
  still matches `env.ADMIN_ADDRESSES`. The env itself is already trimmed,
  lower-cased, and de-emptied by `src/config.ts`.

Like `requireAuth`, all failure paths return `401 Unauthorized` with body
`{ error: "Unauthorized" }` — never `403`. This avoids leaking whether
the request was authenticated-but-not-admin.

## Out of scope (intentional non-goals)

- **Pagination/batching of principals.** Some other code paths in the
  repo paginate or batch — every list endpoint uses `parsePagination`
  (`src/utils/validation.ts`), and the batch endpoints
  (`/events/process_batch`, `/reprocess-events/batch`,
  `/indexed/payments/...`) cap batch sizes with `MAX_BATCH_SIZE = 50` —
  but those are route-layer contracts that act **on** authenticated
  resources, not contracts that distribute **authentication** across many
  addresses at once. If a future route needs to enforce "this caller can
  act on each of these N addresses", that is a dedicated authz layer, not
  a change to this file.
- **OAuth scopes / token introspection.** We accept only the raw bearer
  token. No `scope`, no `Bearer realm="…"`, no JWT verification. If any of
  that is ever required, it lives in a new middleware.
- **Per-route rate-limit overrides on auth headers.** Rate limiting lives
  in `src/middleware/rate-limit.ts`; this middleware is unaware of it.
- **Rotating vs. raw tokens.** `requireSession` treats whatever is in
  `Authorization` as a raw session token. Refresh tokens go through
  `rotateSession` in `src/auth/session.ts`, not through this middleware.
- **Logging the rejection reason.** The granularity is intentionally
  surfaced in `requireSession`'s log/metric stream and not on the wire.
  This file must not log addresses, tokens, or rejection reasons at
  info/warn level.

## Change management

When changing anything in this file, the acceptance bar is:

1. The runtime path, the tests in `src/auth/middleware.test.ts`, **and**
   this document describe the same behavior. If you change one without
   updating the other two, the change is incomplete.
2. The single-principal invariant is preserved or, if intentionally
   lifted, accompanied by an explicit design note in this file and a
   follow-up issue.
3. The wire envelope stays `{ error: "Unauthorized" }` / `401` for every
   non-success path. Do not add `error_code`, `reason`, or any field that
   would let a probe distinguish reasons.
4. `pnpm test`, `pnpm lint`, and `pnpm build` all pass before opening a
   PR.
