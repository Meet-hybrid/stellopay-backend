# Transactions Routes

> **Module:** `src/routes/transactions.ts`  
> **Base path:** `/api/v1`

## Overview

The transactions module serves a unified, paginated transaction history by merging rows from
five entity tables — payments, escrow events, agreement events, employees, and milestones —
into a single chronological feed. It is designed for display in a wallet-style UI where every
row shares a common shape regardless of its origin.

## Architecture

The module avoids repeated computation by extracting shared logic into route-agnostic helpers:

| Helper | Purpose |
|--------|---------|
| `parsePagination(req)` | Parses `limit` and `offset`, clamps limit to [1, 100] |
| `parseEventTypes(req)` | Splits comma-separated `eventTypes` into a string array |
| `parseDateFilters(req)` | Converts `startDate`/`endDate` query params to `Date` objects |
| `buildConditions(userAddress, filters)` | Builds WHERE conditions for all five entity tables |
| `fetchAndBuildTransactions(userAddress, conds, queryLimit, opts)` | Runs all count + data queries in parallel, resolves escrow tokens, merges/formats/sorts the feed |
| `respondPaginated(res, transactions, total, limit, offset)` | Slices, paginates, and sends the JSON response |

This structure means both route handlers are thin wrappers (~15 lines each) that parse
parameters, delegate to `fetchAndBuildTransactions`, and call `respondPaginated`.

### Merge strategy

The module fetches `queryLimit` rows from each of the five entity tables in parallel,
merges them in application code, sorts by `createdAt` descending (with `txHash` as a
stable tiebreaker), then slices for the requested page. This guarantees each entity type
is represented in the merged feed and keeps the pagination semantics predictable.

**Why not a UNION query?**  
The five entity tables have different schemas (columns, joins), so a single SQL UNION is
impractical in Drizzle. The application-level merge avoids complex SQL while keeping each
table's query simple and independently optimisable.

## Endpoints

### `GET /api/v1/transactions/:user_address`

Returns a paginated, merged transaction history for the given Starknet address.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer (1–100) | 50 | Max items per page; values > 100 are clamped |
| `offset` | integer (≥ 0) | 0 | Number of items to skip |
| `eventTypes` | string (comma-separated) | — | Filter to specific event types (e.g. `PaymentSent,Funded`) |

**Contract differences from the filtered endpoint:**
- Supports `eventTypes` filter but **not** date-range filters.
- Enables **deduplication** of agreement events with duplicate `id` values.
- Uses `"employer-or-employee"` mode for employee events — matches where the
  requesting user is either the employer or the employee.

**Response (`200`):**

```json
{
  "transactions": [
    {
      "id": "0x12345678",
      "type": "Payment Received",
      "address": "0x0678...dacd",
      "date": "Jun 15, 2025",
      "time": "10:30AM",
      "token": "STRK",
      "amount": "+10.5 STRK",
      "status": "Completed",
      "tokenIcon": "STRK",
      "txHash": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      "createdAt": "2025-06-15T10:30:00.000Z"
    }
  ],
  "total": 42,
  "hasMore": true,
  "limit": 50,
  "offset": 0
}
```

---

### `GET /api/v1/transactions/:user_address/filtered`

Same merged transaction feed, with additional date-range filtering.

**Query parameters** (all from the main endpoint, plus):

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `startDate` | ISO date string | — | Inclusive lower bound on `createdAt` |
| `endDate` | ISO date string | — | Inclusive upper bound on `createdAt` |

**Contract differences from the main endpoint:**
- Supports date-range filters but **not** `eventTypes`.
- Does **not** deduplicate agreement events.
- Uses `"employee-only"` mode for employee events — matches only where the
  requesting user **is** the employee.

The response shape is identical to the main endpoint.

> **Note:** This endpoint does **not** support the `eventTypes` filter, and the main
> endpoint does **not** support date filters. These are intentionally separate concerns.
> If you need both filters simultaneously, prefer merging them on the client side or
> file a feature request to unify the two endpoints.

## Transaction item fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | First 10 chars of the transaction hash |
| `type` | string | Human-readable event label (see [Event types](#event-types)) |
| `address` | string | Truncated **counterparty** address (`0x1234...5678`); see [Address field resolution](#address-field-resolution) |
| `date` | string | Formatted date (`Jun 15, 2025`) |
| `time` | string | Formatted time (`10:30AM`) |
| `token` | string | Token symbol (e.g. `STRK`, `USDC`) or `-` if N/A |
| `amount` | string | Formatted amount with sign, or `-` if N/A |
| `status` | `"Completed"` | Always `"Completed"` for now |
| `tokenIcon` | string | Token icon identifier, or `""` if N/A |
| `txHash` | string | Full Starknet transaction hash |
| `createdAt` | Date | ISO timestamp from the source row |

All fields are guaranteed present (never `undefined`), though some may hold placeholder
values (`"-"` for `token`/`amount`, `""` for `tokenIcon`) when the information is not
available for a given entity type.

## Address field resolution

The `address` field in every `TransactionItem` represents the **other party** involved
in the event, relative to the requesting user. The resolution logic differs per entity type:

| Entity type | Resolution logic |
|-------------|------------------|
| **Agreement events** | If the user is the employer → shows the **contributor**. If the user is the contributor → shows the **employer**. Falls back to `"N/A"` if the counterparty is missing. |
| **Payments** | If `PaymentSent` → shows the **`to`** address (receiver). If `PaymentReceived` → shows the **`from`** address (sender). |
| **Escrow events** | If `Funded` → shows the **employer**. If `Released` or `Refunded` → shows the **`to`** address (recipient). Falls back to `""` if the address is missing. |
| **Employee events** | If the user is the employer → shows the **employee address**. If the user is the employee → shows the **employer**. Falls back to `"N/A"` if neither is available. |
| **Milestone events** | If the user is the employer → shows the **contributor**. If the user is the contributor → shows the **employer**. Falls back to `"N/A"` if the counterparty is missing. |

### Address formatting

All addresses are normalized via `normalizeStarknetAddress` and then truncated for display:

- **Normalized** to lowercase `0x` + 64 hex characters.
- **Truncated** to `0x` + first 6 hex chars + `...` + last 4 hex chars (e.g. `0x123456...abcd`).
- If the normalized address is 10 characters or shorter, it is returned whole.
- Falsy or `"N/A"` values pass through unchanged.

## Event types

The module maps internal event-type constants to human-readable labels. This mapping lives
in a single `formatEventType` function used by both endpoints — it is the **single source
of truth** for event type display.

| Internal | Display |
|----------|---------|
| `PaymentSent` | Payment Sent |
| `PaymentReceived` | Payment Received |
| `Funded` | Agreement Funded |
| `Released` | Payment Released |
| `Refunded` | Refund Received |
| `AgreementCreated` | Agreement Created |
| `AgreementActivated` | Agreement Activated |
| `AgreementPaused` | Agreement Paused |
| `AgreementResumed` | Agreement Resumed |
| `AgreementCancelled` | Agreement Cancelled |
| `AgreementCompleted` | Agreement Completed |
| `AgreementStatusChange` | Agreement Status Changed |
| `EmployeeAdded` | Employee Added |
| `MilestoneAdded` | Milestone Added |
| `MilestoneApproved` | Milestone Approved |
| `MilestoneClaimed` | Milestone Claimed |
| `PayrollClaimed` | Payroll Claimed |
| `DisputeRaised` | Dispute Raised |
| `DisputeResolved` | Dispute Resolved |
| *(unknown)* | PascalCase with spaces inserted |

### Synthetic event types

Two entity types produce synthetic event types that are not stored in the database:

- **Employee events** → always `"Employee Added"`
- **Milestone events** → always `"Milestone Added"`

These are added at the application layer during the merge step.

## Per-entity-type token and amount display

| Entity type | `token` field | `amount` field | `tokenIcon` field |
|-------------|---------------|----------------|-------------------|
| **Agreement events** | `"-"` | `"-"` | `""` |
| **Payments** | Resolved from the payment's `token` column | Formatted amount with `+`/`-` sign prefix | Resolved icon |
| **Escrow events** | Resolved from the agreement token (DB + on-chain lookup) | Formatted amount with `+`/`-` sign prefix | Resolved icon |
| **Employee events** | `"-"` | `"-"` | `""` |
| **Milestone events** | `"-"` | `"-"` | `""` |

## Pagination contract

- `limit` is clamped to the range [1, 100]. Requesting `limit=200` silently becomes 100.
- `offset` defaults to 0 and must be ≥ 0.
- `total` is the sum of matching rows across all five source tables.
- `hasMore` is `true` when `total > offset + limit`. It is `false` when `total ≤ offset + limit`.
- When `offset ≥ total`, the `transactions` array is empty.
- Each table fetches `offset + limit` rows and the merge happens in application memory.

## Sort contract

The merged transaction feed is sorted by two criteria:

1. **Primary:** `createdAt` descending — newest transactions first.
2. **Tiebreaker:** `txHash` ascending (lexicographic string comparison) — provides stable
   ordering when multiple transactions share the same timestamp.

This sort is applied to the **full set** of merged rows before pagination slicing, so
the sort order is consistent regardless of page boundaries.

## Token resolution for escrow events

Escrow events do not carry a token address directly. The module resolves tokens in two steps:

1. **Database fallback:** Looks up the agreement's `token` column.
2. **On-chain lookup:** Calls the agreement contract's `get_token()` method, preferring
   the on-chain value when available. Results are cached in-memory for 5 minutes (TTL:
   `TOKEN_CACHE_TTL_MS = 300_000`).

If both sources return nothing, the token and amount display as `"-"`.

## Token amount display

- **STRK:** Whole amount plus up to 6 decimal places, followed by the token symbol.
  Examples: `10.5 STRK`, `0.000001 STRK`.
- **USDC / USDT:** Dollar format with exactly 2 decimal places, followed by the amount.
  Examples: `$10.50`, `$0.01`.
- **Zero / empty amounts:** Displayed as `"-"` regardless of token type.
- **Sign prefix:** `+` for incoming events (received, released, refunded), `-` for outgoing
  events (sent, funded). The sign is applied by the caller (`fetchAndBuildTransactions`),
  not by the `formatAmount` helper.

## Deduplication

The main endpoint uses `{ deduplicateAgreementEvents: true }` so that agreement events
with duplicate `id` values are collapsed to one row. This prevents duplicate rows when the
same event is indexed multiple times.

The filtered endpoint does **not** deduplicate, preserving all raw rows.

## Employee condition mode

- **Main endpoint** (`"employer-or-employee"`): Matches employee events where the
  requesting user is **either** the employer **or** the employee (wider net).
- **Filtered endpoint** (`"employee-only"`): Matches only where the requesting user
  **is** the employee (narrower scope, used with date-range filtering).

## Error codes

| Status | Condition |
|--------|-----------|
| `400`  | Invalid query parameter (e.g. non-numeric limit) |
| `500`  | Unexpected server error (e.g. database failure, contract call failure) |

## Logging

Diagnostic logs (token comparison, fetch progress, amount formatting) are emitted via
`console.debug` **only** when `LOG_LEVEL` is set to `"debug"`. At the default `"info"`
level these lines are suppressed, keeping sensitive token addresses and per-request noise
out of production logs. Genuine failures always use `console.error` or `console.warn`.

## Intentionally out of scope

- **Write operations.** This module is read-only. Creating payments, escrow events, or
  agreement events happens through the indexer and is not part of the HTTP API.
- **Real-time subscriptions.** The feed is purely request-response. WebSocket or SSE
  streaming is not implemented.
- **Unified filtering.** The main endpoint supports `eventTypes` but not date range; the
  filtered endpoint supports date range but not `eventTypes`. Unifying these into a single
  endpoint is a candidate for a future PR but is out of scope here to keep the change small
  and backwards-compatible.
- **Per-table row limits.** Each table fetches `offset + limit` rows and the merge happens
  in application memory. For pages deep into the result set this means fetching more rows
  than strictly necessary. A cursor-based approach or a materialized view would be required
  to eliminate this overhead, but the current approach remains the pragmatic default.

## Testing

```bash
pnpm test -- src/routes/transactions.test.ts
```

The test suite covers:

- Success-path responses with correct envelope shape for both endpoints
- Transaction item field validation (all documented keys present, correct types)
- Pagination: limit clamping, default values, offset, hasMore calculation
- Event type filtering on the main endpoint
- Date range filtering on the filtered endpoint
- Empty result sets (zero total, empty array, hasMore=false)
- Database-failure fallback (500)
- Log-level gating (silent at `info`, verbose at `debug`)
- Response shape consistency between the two endpoints
- **Sort order contract** — `createdAt` descending, `txHash` tiebreaker
- **Address field contract** — per-entity-type counterparty resolution
- **Amount formatting contract** — STRK/USDC/USDT with sign prefix, zero as `"-"`
- **FormatAddress contract** — truncated `0x1234...5678` pattern
- **Deduplication contract** — main endpoint dedupes agreement events
- **Boundary conditions** — `hasMore` at exact boundary, `offset` beyond total
- **Endpoint contract differences** — main supports eventTypes, filtered supports dates
