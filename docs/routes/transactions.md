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

### Why not a UNION query?

The five entity tables have different schemas (columns, joins), so a single SQL UNION is
impractical in Drizzle. The current approach fetches `queryLimit` rows from each table in
parallel, merges them in application code, sorts by `createdAt` descending, and then slices
for the requested page. This guarantees each table is represented in the merged feed and
keeps the pagination semantics predictable.

## Endpoints

### `GET /api/v1/transactions/:user_address`

Returns a paginated, merged transaction history for the given Starknet address.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer (1–100) | 50 | Max items per page; values > 100 are clamped |
| `offset` | integer (≥ 0) | 0 | Number of items to skip |
| `eventTypes` | string (comma-separated) | — | Filter to specific event types (e.g. `PaymentSent,Funded`) |

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

**Transaction item fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | First 10 chars of the transaction hash |
| `type` | string | Human-readable event label (see [Event types](#event-types)) |
| `address` | string | Truncated counterparty address (`0x1234...5678`) |
| `date` | string | Formatted date (`Jun 15, 2025`) |
| `time` | string | Formatted time (`10:30AM`) |
| `token` | string | Token symbol (e.g. `STRK`, `USDC`) or `-` if N/A |
| `amount` | string | Formatted amount with sign, or `-` if N/A |
| `status` | `"Completed"` | Always `"Completed"` for now |
| `tokenIcon` | string | Token icon identifier, or `""` if N/A |
| `txHash` | string | Full Starknet transaction hash |
| `createdAt` | Date | ISO timestamp from the source row |

---

### `GET /api/v1/transactions/:user_address/filtered`

Same merged transaction feed, with additional date-range filtering.

**Query parameters** (all from the main endpoint, plus):

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `startDate` | ISO date string | — | Inclusive lower bound on `createdAt` |
| `endDate` | ISO date string | — | Inclusive upper bound on `createdAt` |

The response shape is identical to the main endpoint.

> **Note:** This endpoint does **not** support the `eventTypes` filter, and the main
> endpoint does **not** support date filters. These are intentionally separate concerns.
> If you need both filters simultaneously, prefer merging them on the client side or
> file a feature request to unify the two endpoints.

## Event types

The module maps internal event-type constants to human-readable labels. This mapping lives
in a single `formatEventType` function used by both endpoints.

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

## Pagination contract

- `limit` is clamped to the range [1, 100]. Requesting `limit=200` silently becomes 100.
- `offset` defaults to 0 and must be ≥ 0.
- `total` is the sum of matching rows across all five source tables.
- `hasMore` is `true` when `total > offset + limit`.
- The merged feed is sorted by `createdAt` descending, then by `txHash` for stable tie-breaking.

## Token resolution for escrow events

Escrow events do not carry a token address directly. The module resolves tokens in two steps:

1. **Database fallback:** Looks up the agreement's `token` column.
2. **On-chain lookup:** Calls the agreement contract's `get_token()` method, preferring
   the on-chain value when available. Results are cached in-memory for 5 minutes.

If both sources return nothing, the token and amount display as `"-"`.

## Token amount display

- **STRK:** Whole amount plus up to 6 decimal places, e.g. `10.5 STRK`
- **USDC / USDT:** Dollar format with exactly 2 decimal places, e.g. `$10.50`
- **Zero / empty amounts:** Displayed as `"-"`
- **Sign prefix:** `+` for incoming (received, released, refunded), `-` for outgoing (sent, funded)

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
