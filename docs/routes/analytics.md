# `src/routes/analytics.ts` — Aggregation Rollup Observability

## Overview

Exposes `GET /api/v1/analytics/:user_address` — a monthly aggregation rollup that combines:
- **Payment events** (direct P2P transfers), 
- **Escrow events** (Funded / Released / Refunded), and 
- **Agreement creation events** (proxy for platform activity).

Each query is a DB-side `EXTRACT(MONTH FROM ...)` grouping, filtered to the caller's address and the requested year. Results are formatted as 12-month chart data suitable for UI rendering.

---

## Input Validation & Input Hardening

- **`user_address` (path param)**:
  - Validated via `StarknetAddress` Zod schema (hex string up to 64 chars, optional `0x` prefix).
  - Transformed into canonical normalized hex address before database querying.
  - Invalid formats throw a `ZodError` mapped to HTTP 400 before database execution.
- **`year` (query param)**:
  - Validated via `AnalyticsQuerySchema`.
  - Must be an integer within the range `2020` to `2100`.
  - Empty values (`""`, `null`, `undefined`) fall back gracefully to the current year (`new Date().getFullYear()`).
  - Malformed strings, non-integers (e.g. `2026.5`), or out-of-range years (`1999`, `3000`) throw a `ZodError` mapped to HTTP 400.

---

## Data Aggregation Robustness

- **Safe Amount Parsing (`parseBigIntSafe`)**:
  - Raw amount values from database rows (`payments`, `escrowEvents`) are safely parsed using `parseBigIntSafe`.
  - Missing, `null`, `undefined`, or unparseable string values fall back to `0n` instead of throwing unhandled `TypeError` or `SyntaxError` exceptions.
- **Month Bounds Check (`isValidMonth`)**:
  - Extracted month values are checked via `isValidMonth(month)` to ensure they are integers between `1` and `12`.
  - Any corrupted or out-of-bound month values are safely skipped without corrupting chart data or array indexing.

---

## Telemetry & Metrics

Every invocation of the rollup endpoint is instrumented. Telemetry fires **after all three DB queries complete** (success path) or **inside the catch block for non-Zod errors** (error path), and respects global `LOG_FORMAT` and `LOG_LEVEL` settings. Zod 400 validation failures do not emit DB error telemetry.

### Log format — JSON (`LOG_FORMAT=json`)

**Success:**
```json
{
  "timestamp": "2026-07-26T18:47:00.123Z",
  "level": "info",
  "operation": "analytics_monthly_rollup",
  "duration_ms": 72.14,
  "status": "success",
  "request_id": "req-abc-001",
  "user_address": "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
  "year": 2026,
  "row_counts": {
    "payments": 4,
    "escrow_events": 7,
    "agreement_creations": 2
  }
}
```

**Error (DB failure):**
```json
{
  "timestamp": "2026-07-26T18:47:05.456Z",
  "level": "error",
  "operation": "analytics_monthly_rollup",
  "duration_ms": 1204.88,
  "status": "error",
  "request_id": "req-abc-001",
  "user_address": "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
  "error": "DB connection lost"
}
```

### Log format — text (`LOG_FORMAT=text`)

```text
[2026-07-26T18:47:00.123Z] INFO [analytics-telemetry] analytics_monthly_rollup success 72.14ms [req-abc-001] rows={"payments":4,"escrow_events":7,"agreement_creations":2}
```

---

## Telemetry Fields

| Field | Type | Present on | Description |
|---|---|---|---|
| `timestamp` | ISO 8601 string | always | Log emission time |
| `level` | `"info"` / `"error"` | always | Log severity |
| `operation` | string | always | `"analytics_monthly_rollup"` |
| `duration_ms` | number | always | End-to-end query + aggregation latency |
| `status` | `"success"` / `"error"` | always | Outcome |
| `request_id` | string | when set | Correlation ID from `res.locals.requestId` |
| `user_address` | string | always | Normalized Starknet address |
| `year` | number | success | Year used for date range filter |
| `row_counts` | object | success | `{ payments, escrow_events, agreement_creations }` |
| `error` | string | error | Error message |

---

## Security & Reliability Notes

- `duration_ms` is total DB round-trip time for all three queries, useful as a latency gauge against slow queries or pool exhaustion.
- `row_counts` is a diagnostic metric; it does not leak per-row data or PII.
- `user_address` in logs is the **normalized** form; no raw user input appears in logs.
- Unparseable amounts or malformed DB rows default to zero rather than crashing the endpoint with a 500 error.

---

## Intentionally Out of Scope

| Item | Reason |
|---|---|
| Per-table query timers | All three queries are sequential; the aggregate time is sufficient for diagnosing slow paths. Split timers can be added if per-query breakdown is needed. |
| Token-specific breakdowns | Amounts are aggregated across all tokens with `DEFAULT_TOKEN_DECIMALS`; per-token aggregation requires schema changes. |
| Caching / memoization metrics | No caching is applied at the route layer; cache hit/miss telemetry is out of scope here. |
| WCAG / accessibility | Not applicable to this server-side route. |
