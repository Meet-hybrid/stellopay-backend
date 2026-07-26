# `src/routes/read.ts` — Read Route Telemetry & Observability

## Overview

Exposes endpoints for querying read-only token metadata and contract details directly from the Starknet blockchain using JSON-RPC calls.

To quickly diagnose and investigate production failures or slow RPC providers, this route has been equipped with structured telemetry logging.

---

## Telemetry & Metrics Schema

Every blockchain read operation in this file tracks the latency (in milliseconds) and outcome (success/failure) of the Starknet RPC calls. Telemetry logs are printed using `console.info` or `console.error` and respect the global server configuration format:

### JSON Format (`LOG_FORMAT=json`)

When configured for JSON logging, telemetry entries are written as a single line of structured JSON:

```json
{
  "timestamp": "2026-07-26T18:34:25.123Z",
  "level": "info",
  "operation": "erc20_decimals",
  "duration_ms": 48.72,
  "status": "success",
  "token": "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "request_id": "req-client-001"
}
```

On errors, the severity is marked as `error` and the JSON log includes the error message details:

```json
{
  "timestamp": "2026-07-26T18:34:28.456Z",
  "level": "error",
  "operation": "erc20_symbol",
  "duration_ms": 1205.41,
  "status": "error",
  "token": "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  "request_id": "req-client-001",
  "error": "RPC Timeout"
}
```

### Text Format (`LOG_FORMAT=text`)

When text format is selected, telemetry entries are formatted for readability:

```text
[2026-07-26T18:34:25.123Z] INFO [read-telemetry] erc20_decimals success 48.72ms [req-client-001]
```

Or on error:

```text
[2026-07-26T18:34:28.456Z] ERROR [read-telemetry] erc20_symbol error 1205.41ms [req-client-001] error=RPC Timeout
```

---

## Logged Properties

The telemetry payload captures the following metadata depending on the endpoint and invocation context:

- `timestamp`: ISO 8601 string of when the log was generated.
- `level`: `"info"` on success, `"error"` on failures.
- `operation`: The identifier of the action performed. Possible values:
  - `erc20_balance_of`
  - `erc20_decimals`
  - `erc20_symbol`
  - `escrow_get_agreement_balance`
  - `escrow_get_summary`
  - `agreement_get_summary`
- `duration_ms`: High-resolution elapsed time (in milliseconds) representing the network call latency.
- `status`: `"success"` or `"error"`.
- `request_id`: The correlation ID associated with the request (from `res.locals.requestId`).
- `token`: Starknet address of the queried ERC20 contract.
- `owner`: Starknet address of the balance owner.
- `escrow`: Starknet address of the queried `PayrollEscrow` contract.
- `agreement`: Starknet address of the queried `WorkAgreement` contract.
- `agreement_id`: Unique index identifier of the queried agreement.
- `error`: The error message string if the call failed.

---

## Intentionally Out of Scope

- **Retry logic / Failover handling**: The raw RPC provider handles multi-url retry/failover. Telemetry logs the duration and final status of the call block, not internal retries.
- **In-memory cache metrics**: Only the raw blockchain read path is instrumented. Metadata caching is currently limited to token endpoints and is documented separately.
