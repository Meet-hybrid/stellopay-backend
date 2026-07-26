# `src/utils/validation.ts`

Central schema validation and error-mapping module. All path/query parameter
validation for routes goes through the exports here so the rejection contract
is defined once and enforced consistently before any database or RPC call.

---

## Exports

### `StarknetAddress` _(Zod schema)_

Validates and normalises a Starknet address supplied as a path or query
parameter.

**Accepts:** a hex string of 1–64 hex characters, with or without a `0x`
prefix. Leading/trailing whitespace is trimmed before validation.

**Returns:** the canonical form — lowercase `0x` + 64 hex characters — ready
for a database lookup key.

**Rejects:**
- Empty or whitespace-only strings
- Non-hex characters (including unicode lookalikes such as fullwidth digits)
- Strings longer than 64 hex characters after the optional `0x` prefix
- Mixed-case inputs whose casing does not match the SNIP-23/EIP-55 checksum

```ts
StarknetAddress.parse("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d");
// → "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"

StarknetAddress.parse("abc");
// → "0x0000000000000000000000000000000000000000000000000000000000000abc"

StarknetAddress.parse("0xGGG"); // throws ZodError
```

---

### `AgreementId` _(Zod schema)_

Validates a numeric agreement identifier passed as a string.

**Accepts:** strings containing only ASCII digits (`0`–`9`), optionally with
surrounding whitespace (trimmed). Leading zeros are preserved.

**Returns:** the trimmed string unchanged.

**Rejects:**
- Empty or whitespace-only strings
- Any non-digit character, including `-`, `.`, `e`, `0x` prefixes, and
  unicode digit forms (e.g. fullwidth `４２`, Devanagari `०१`)

```ts
AgreementId.parse("42");     // → "42"
AgreementId.parse("00042");  // → "00042"
AgreementId.parse("-1");     // throws ZodError
AgreementId.parse("1.5");    // throws ZodError
```

---

### `parsePagination(query)` _(function)_

Parses and clamps `limit` / `offset` query parameters for list endpoints.
This function **never throws** — any input shape returns a valid, finite pair.

**Parameters:**

| Name    | Type      | Description                                                                  |
| ------- | --------- | ---------------------------------------------------------------------------- |
| `query` | `unknown` | Typically `req.query`. Non-plain-object values fall back to defaults silently.|

**Returns:** `{ limit: number, offset: number }`

**Clamping rules:**

| Parameter | Minimum | Maximum          | Default              |
| --------- | ------- | ---------------- | -------------------- |
| `limit`   | `1`     | `MAX_PAGE_LIMIT` | `DEFAULT_PAGE_LIMIT` |
| `offset`  | `0`     | _(none)_         | `0`                  |

**Special input handling:**

| Input value for a field | Outcome                              |
| ----------------------- | ------------------------------------ |
| `undefined` / missing   | Falls back to documented default     |
| `null` or `""`          | Treated as missing; falls back too   |
| Non-numeric string      | Falls back to documented default     |
| Non-integer float       | Falls back to documented default     |
| Out-of-safe-integer     | Falls back to documented default     |
| Top-level non-object    | Treated as `{}`; both fields default |

The `null`/`""` normalisation prevents `z.coerce.number()` from silently
coercing them to `0`, which would bypass `DEFAULT_PAGE_LIMIT` and return only
one row — an inconsistency relative to how `undefined` behaves.

```ts
parsePagination({ limit: "10", offset: "20" }); // { limit: 10, offset: 20 }
parsePagination({ limit: "5000" });              // { limit: 100, offset: 0 }
parsePagination({ offset: "-3" });               // { limit: 50, offset: 0 }
parsePagination({ limit: null });                // { limit: 50, offset: 0 }
parsePagination("not-an-object");               // { limit: 50, offset: 0 }
parsePagination(undefined);                     // { limit: 50, offset: 0 }
```

---

### `MAX_PAGE_LIMIT` _(constant)_

`100` — the maximum number of rows any list endpoint will return in one
response. `parsePagination` enforces this as a hard upper bound.

---

### `DEFAULT_PAGE_LIMIT` _(constant)_

`50` — the page size used when the caller supplies no usable `limit`.

---

### `loggedParse<T>(schema, value, validatorName)` _(function)_

Wraps a Zod schema with structured error logging. On failure it logs a
[`ValidationErrorMetric`](#validationerrormetric-interface) and throws a
[`ValidationError`](#validationerror-class). On success it returns the
schema's parsed output unchanged.

**Parameters:**

| Name            | Type              | Description                                             |
| --------------- | ----------------- | ------------------------------------------------------- |
| `schema`        | `z.ZodSchema<T>`  | The Zod schema to validate against.                     |
| `value`         | `unknown`         | The raw, untrusted input.                               |
| `validatorName` | `string`          | Short label that appears in the log for identification. |

**Returns:** `T` — the schema's output type.

**Throws:** [`ValidationError`](#validationerror-class) when the schema
rejects `value`.

Use `instanceof ValidationError` to distinguish a schema rejection from any
other runtime error:

```ts
import { loggedParse, ValidationError } from "../utils/validation.js";

try {
  const address = loggedParse(StarknetAddress, req.params.address, "StarknetAddress");
} catch (err) {
  if (err instanceof ValidationError) {
    // schema rejected the input — safe to map to 400
    res.status(400).json({ error: err.message });
  } else {
    next(err); // unexpected — let the central error handler deal with it
  }
}
```

---

### `ValidationError` _(class)_

Error subclass thrown by `loggedParse` on schema rejection. Extends `Error`.

| Property  | Type                    | Description                                              |
| --------- | ----------------------- | -------------------------------------------------------- |
| `name`    | `"ValidationError"`     | Fixed discriminant.                                      |
| `message` | `string`                | The Zod issue messages joined with `"; "`.               |
| `cause`   | `z.ZodError`            | The original `ZodError` with full issue detail.          |
| `metric`  | `ValidationErrorMetric` | The structured payload that was also written to the log. |

Callers that previously caught `z.ZodError` directly should switch to
`instanceof ValidationError` — the `ZodError` is available on `.cause` when
the full issue list is needed.

---

### `ValidationErrorMetric` _(interface)_

Structured payload written to `console.warn` on every validation failure and
attached to `ValidationError.metric`.

```ts
interface ValidationErrorMetric {
  validator: string;  // validatorName passed to loggedParse
  input: string;      // truncated (≤ 40 chars) preview of the raw input
  error: string;      // Zod issue messages joined with "; "
  timestamp: string;  // ISO 8601 timestamp
}
```

The `input` field is always truncated to 40 characters to prevent accidental
logging of long or sensitive payloads. Never pass secrets as the direct
`value` argument to `loggedParse`.

---

## Error flow

```
loggedParse(schema, value, name)
  │
  ├─ schema.safeParse(value) succeeds → return parsed data
  │
  └─ schema.safeParse(value) fails
       │
       ├─ build ValidationErrorMetric { validator, input, error, timestamp }
       ├─ console.warn("[validation:error] " + JSON.stringify(metric))
       └─ throw new ValidationError(zodError, metric)
                │
                ├─ .name    = "ValidationError"
                ├─ .message = metric.error
                ├─ .cause   = ZodError
                └─ .metric  = ValidationErrorMetric
```

---

## Callers

| File                               | Schemas used                              |
| ---------------------------------- | ----------------------------------------- |
| `src/routes/indexed.ts`            | `StarknetAddress`, `AgreementId`, `parsePagination` |
| `src/routes/indexer-status.ts`     | `StarknetAddress`, `parsePagination`      |
| `src/routes/agreement.ts`          | `StarknetAddress`                         |
| `src/routes/analytics.ts`          | `StarknetAddress`                         |
| `src/routes/notifications.ts`      | `StarknetAddress`                         |

All callers use `.parse()` directly on `StarknetAddress` or `AgreementId`.
Only `loggedParse` additionally logs and wraps the error in `ValidationError`;
raw `.parse()` still throws a plain `ZodError`. Migrate call-sites to
`loggedParse` when structured diagnostics or `instanceof` discrimination is
needed.

---

## Out of scope

The following are intentionally not handled by this module:

- **Request-body schemas** — defined inline in each route file using Zod.
  Moving them here would couple unrelated route contracts.
- **Token-amount validation** — handled by `src/utils/codec.ts`
  (`formatTokenAmount`), which owns its own `TypeError`/`RangeError` contract.
- **Session / auth validation** — owned by `src/auth/`.
- **Database-layer validation** — Drizzle enforces column types at the ORM
  level; this module only covers HTTP input parameters.
