# `src/routes/indexed.ts` — Route Documentation

## Overview

Exposes four read-only endpoints that surface indexed on-chain data stored in
the PostgreSQL database by the Apibara indexer. All data originates from the
two live Stellopay contracts (`WorkAgreement` and `PayrollEscrow`).

---

## Authorization Contract

These endpoints are **unauthenticated** (no session required). They expose
aggregate, non-sensitive indexed data for use by the frontend.

However, every endpoint that accepts a `contract_address` parameter enforces a
**sync-checkpoint guard**: the normalized address must match the active
configured contract for that endpoint. Requests with a stale, wrong, or
arbitrary contract address are rejected before any database call.

| Condition | HTTP status |
|---|---|
| Non-hex / malformed address param | `400 Validation failed` (Zod) |
| Valid hex, but wrong contract for this endpoint | `400 Bad Request` |
| Valid address and matching contract | `200 OK` |

---

## Sync Checkpoint Contract Addresses

The active contract addresses are resolved at server startup from environment
variables (with hard-coded Sepolia defaults):

| Variable | Role | Default |
|---|---|---|
| `WORK_AGREEMENT_ADDRESS` | `WorkAgreement` contract | `0x0678...dacd` |
| `PAYROLL_ESCROW_ADDRESS` | `PayrollEscrow` contract | `0x06d3...b1d4` |

Any `contract_address` parameter supplied to a route must exactly match the
**normalized** (lowercase, 66-character `0x`-prefixed) form of the expected
contract for that endpoint.

---

## Endpoints

### `GET /api/v1/indexed/agreements/:contract_address/user/:user_address`

Returns all agreements where the user is employer, contributor, or payroll
employee, deduped and bounded by the pagination limit.

**Path Parameters**

| Param | Constraint |
|---|---|
| `contract_address` | Must equal normalized `WORK_AGREEMENT_ADDRESS` |
| `user_address` | Any valid Starknet hex address |

**Query Parameters**

| Param | Type | Default | Constraints |
|---|---|---|---|
| `limit` | integer | `50` | Clamped to 1–100 |
| `offset` | integer | `0` | ≥ 0 |

**Responses**

```jsonc
// 200 OK
{
  "agreements": [ /* agreement rows */ ],
  "count": 2,
  "source": "indexed"
}

// 400 — wrong contract address
{ "error": "Invalid contract address for agreements" }

// 400 — malformed address (Zod)
{ "error": "Validation failed", "details": [ ... ] }
```

---

### `GET /api/v1/indexed/agreement/:contract_address/:agreement_id`

Returns full detail for a single agreement, including events, payments,
milestones, employees, and escrow events.

**Path Parameters**

| Param | Constraint |
|---|---|
| `contract_address` | Must equal normalized `WORK_AGREEMENT_ADDRESS` |
| `agreement_id` | Numeric string (`^\d+$`) |

**Responses**

```jsonc
// 200 OK
{
  "agreement": { /* agreement row */ },
  "events": [ ... ],
  "payments": [ ... ],
  "milestones": [ ... ],
  "employees": [ ... ],
  "escrowEvents": [ ... ]
}

// 400 — wrong contract address
{ "error": "Invalid contract address for agreement details" }

// 400 — non-numeric agreement_id (Zod)
{ "error": "Validation failed", "details": [ ... ] }

// 404 — not found
{ "error": "Agreement not found" }
```

---

### `GET /api/v1/indexed/payments/user/:user_address`

Returns all payment events where the user is the sender or recipient.

**Path Parameters**

| Param | Constraint |
|---|---|
| `user_address` | Any valid Starknet hex address |

**Query Parameters**

| Param | Type | Default | Constraints |
|---|---|---|---|
| `limit` | integer | `50` | Clamped to 1–100 |
| `offset` | integer | `0` | ≥ 0 |

**Responses**

```jsonc
// 200 OK
{ "payments": [ ... ], "count": 3 }

// 400 — malformed address (Zod)
{ "error": "Validation failed", "details": [ ... ] }
```

> **Note:** This endpoint does not take a `contract_address` — payments are
> indexed globally across all contracts.

---

### `GET /api/v1/indexed/escrow/:contract_address/balance/:agreement_id`

Reconstructs the escrow balance for an agreement by summing all `Funded`,
`Released`, and `Refunded` events in insertion order.

**Path Parameters**

| Param | Constraint |
|---|---|
| `contract_address` | Must equal normalized `PAYROLL_ESCROW_ADDRESS` |
| `agreement_id` | Numeric string (`^\d+$`) |

**Responses**

```jsonc
// 200 OK
{
  "agreement_id": "7",
  "balance": "500",          // net balance as a bigint string
  "events": [ ... ]          // all escrow events for this agreement
}

// 400 — wrong contract address
{ "error": "Invalid contract address for escrow balance" }

// 400 — non-numeric agreement_id or malformed address (Zod)
{ "error": "Validation failed", "details": [ ... ] }
```

---

## Security Notes

### What was hardened (issue #247)

| Gap | Fix |
|---|---|
| `contract_address` path param accepted any valid hex string and forwarded it directly to `eq()` DB filter | Strict sync-checkpoint guard: address must match the normalized configured contract for that endpoint, returning `400` otherwise |
| Arbitrary addresses could trigger DB index scans against unconfigured contracts | Contract guard fires before any DB call — no query is executed on mismatch |

### Out of scope (intentionally)

- **Authentication / authorization**: these endpoints are intentionally public
  read-only. If per-user access control is needed in future, add `requireAuth`
  and an ownership check (see `src/routes/transactions.ts` for the pattern).
- **Indexer restart / event re-processing**: handled by
  `src/routes/reprocess-events.ts` and `src/routes/backfill-events.ts`.
- **Indexer liveness / freshness gauge**: the current schema has no
  `last_indexed_block` table; the `GET /indexer/status` endpoint in
  `src/routes/indexer-status.ts` surfaces aggregate counts as a proxy.
- **Multi-contract support**: if additional contracts are deployed and need
  to be indexed, update `WORK_AGREEMENT_ADDRESS` / `PAYROLL_ESCROW_ADDRESS`
  env vars and the sync-checkpoint guard logic in `indexed.ts` accordingly.
