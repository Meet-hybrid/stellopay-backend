# `src/routes/transactions.ts` — Route Documentation

## Overview

Exposes two endpoints that return transaction history for a given Starknet
address. Both endpoints aggregate data from five database tables
(`payments`, `escrowEvents`, `agreementEvents`, `employees`, `milestones`)
and return a unified, sorted, paginated list.

---

## Authorization Contract

Both endpoints require a **valid session token** and enforce **address
ownership**. The authenticated session address (resolved by `requireAuth`
from the `x-user-address` / `Authorization: Bearer <token>` headers) must
exactly match the `user_address` URL parameter after Starknet address
normalization.

| Condition | HTTP status |
|---|---|
| Missing / invalid session token | `401 Unauthorized` |
| Authenticated address ≠ `user_address` param | `403 Forbidden` |
| Valid session, matching address | `200 OK` |

This prevents **cross-user data access**: no authenticated user can read
another user's transaction history, even if they know the target address.

---

## Endpoints

### `GET /api/v1/transactions/:user_address`

Returns a paginated list of all transaction events for the authenticated user.

**Headers (required)**

| Header | Description |
|---|---|
| `x-user-address` | Caller's Starknet address (must match `:user_address`) |
| `Authorization` | `Bearer <session_token>` |

**Query Parameters**

| Parameter | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `limit` | integer | `50` | 1 – 100 (clamped) | Maximum items per page |
| `offset` | integer | `0` | ≥ 0 | Pagination offset |
| `eventTypes` | string | — | Comma-separated; see allowlist below | Filter by one or more event types |

**`eventTypes` Allowlist**

Only the following values are accepted. Providing any value outside this set
returns `400 Bad Request`.

```
AgreementCreated  AgreementActivated  AgreementPaused  AgreementResumed
AgreementCancelled  AgreementCompleted  AgreementStatusChange
PaymentSent  PaymentReceived
MilestoneAdded  MilestoneApproved  MilestoneClaimed
EmployeeAdded  PayrollClaimed
DisputeRaised  DisputeResolved
Funded  Released  Refunded
```

**Responses**

```jsonc
// 200 OK
{
  "transactions": [
    {
      "id": "0x12345678",          // first 10 chars of txHash
      "type": "Payment Sent",
      "address": "0x1234...5678",  // counterparty (truncated)
      "date": "Jul 26, 2025",
      "time": "3:45PM",
      "token": "STRK",
      "amount": "-1.500000 STRK",
      "status": "Completed",
      "tokenIcon": "...",
      "txHash": "0x..."
    }
    // ...
  ],
  "total": 42,
  "hasMore": true,
  "limit": 50,
  "offset": 0
}
```

```jsonc
// 400 Bad Request — unknown eventTypes
{ "error": "Unknown event type(s): INJECT. Allowed values: ..." }

// 401 Unauthorized — missing or invalid session
{ "error": "Unauthorized" }

// 403 Forbidden — session address ≠ param address
{ "error": "Forbidden" }
```

---

### `GET /api/v1/transactions/:user_address/filtered`

Identical to the base endpoint with the addition of **date-range filtering**.
Both authorization and `eventTypes` rules from the base endpoint also apply
here (the filtered endpoint does not accept an `eventTypes` parameter — date
filtering is its sole addition over the base endpoint).

**Additional Query Parameters**

| Parameter | Type | Description |
|---|---|---|
| `startDate` | ISO 8601 string | Lower bound (inclusive) on `createdAt` |
| `endDate` | ISO 8601 string | Upper bound (inclusive) on `createdAt` |

**Date Validation Rules**

- Invalid date strings (e.g. `"not-a-date"`) return `400 Bad Request` with
  `"Invalid startDate"` / `"Invalid endDate"`.
- `startDate` after `endDate` returns `400 Bad Request` with
  `"startDate must not be after endDate."`.
- Omitting both parameters returns all transactions (no date filter).

```jsonc
// 400 Bad Request — invalid date
{ "error": "Invalid startDate — expected an ISO 8601 date string." }

// 400 Bad Request — reversed range
{ "error": "startDate must not be after endDate." }
```

---

## Security Notes

### What was fixed (issue #213)

| Gap | Fix |
|---|---|
| No authentication on either endpoint | `requireAuth` middleware added to both routes |
| Any authenticated user could read any address's history | Address ownership check: `normalizeAddr(req.auth.address) === normalizeAddr(req.params.user_address)`, returns `403` on mismatch |
| `eventTypes` query param forwarded raw to DB `inArray()` | Values validated against `ALLOWED_EVENT_TYPES` constant (a `Set`); unknown values return `400` |
| `startDate` / `endDate` silently produced `Invalid Date` objects | `isNaN(date.getTime())` guard returns `400` before any DB call |

### Out of scope (intentionally)

- **Reconciliation export**: bulk CSV/XLSX export is not yet implemented in
  this router; when it is added it must inherit the same `requireAuth` +
  address-ownership pattern documented here.
- **Admin override**: admin users are currently subject to the same ownership
  check. If admin read-any-address access is needed in future, add a separate
  `requireAdmin`-gated endpoint rather than loosening the existing check.
- **Pagination total accuracy**: the `total` field is the sum of five
  independent `COUNT` queries executed before filtering by offset/limit. It
  reflects the full set size, not the page size — this is intentional and
  matches existing frontend expectations.

---

## Helper Utilities (module-private)

| Function | Purpose |
|---|---|
| `debugLog` | Writes to `console.debug` only when `LOG_LEVEL=debug`; keeps token addresses out of default logs |
| `getTokenInfo` | Resolves a token address to display name, icon, and decimals |
| `formatAmount` | Formats a raw bigint amount with correct decimal scaling and sign |
| `getTokenFromAgreementContract` | Single-agreement token fetch with 5-min TTL in-process cache |
| `batchGetTokensFromAgreementContracts` | Parallel batch fetch with concurrency capped at 10 |
| `formatDate` | Converts a `Date` to `{ date, time }` display strings |
| `formatEventType` | Maps internal event type keys to human-readable labels |
| `ALLOWED_EVENT_TYPES` | `Set<string>` — the definitive list of valid `eventTypes` filter values |
