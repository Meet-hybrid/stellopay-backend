import { z } from "zod";
import { normalizeStarknetAddress } from "./address.js";

/**
 * Structured diagnostic payload emitted on every validation failure.
 *
 * Exported so callers can consume or forward the same shape in their own
 * logging pipelines without duplicating field names.
 *
 * - `validator`  — the name passed to {@link loggedParse}, used to pinpoint
 *   the schema that rejected the input.
 * - `input`      — a truncated (≤ 40 char) preview of the raw input. Never
 *   pass secrets directly as validator input.
 * - `error`      — the Zod issue messages joined with `"; "`.
 * - `timestamp`  — ISO 8601 timestamp at the moment the error was captured.
 */
export interface ValidationErrorMetric {
  validator: string;
  input: string;
  error: string;
  timestamp: string;
}

/**
 * Error subclass thrown by {@link loggedParse} when a Zod schema rejects its
 * input. Wraps the original `ZodError` so callers can use a single
 * `instanceof ValidationError` check to distinguish a schema rejection from
 * any other runtime error without importing Zod directly.
 *
 * @example
 * import { loggedParse, ValidationError } from "./validation.js";
 *
 * try {
 *   loggedParse(MySchema, rawInput, "MySchema");
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     res.status(400).json({ error: err.message, details: err.metric });
 *   } else {
 *     next(err); // unexpected error — let the central handler deal with it
 *   }
 * }
 */
export class ValidationError extends Error {
  /** The original ZodError that triggered this failure. */
  readonly cause: z.ZodError;
  /** Structured diagnostic payload that was also written to the log. */
  readonly metric: ValidationErrorMetric;

  constructor(cause: z.ZodError, metric: ValidationErrorMetric) {
    super(metric.error);
    this.name = "ValidationError";
    this.cause = cause;
    this.metric = metric;
  }
}

function logValidationError(metric: ValidationErrorMetric): void {
  console.warn(`[validation:error] ${JSON.stringify(metric)}`);
}

/**
 * Wraps a Zod schema with structured error logging. On parse failure, logs a
 * {@link ValidationErrorMetric} and throws a {@link ValidationError} that
 * wraps the underlying `ZodError`. This lets callers distinguish a schema
 * rejection from any other runtime error with a single
 * `instanceof ValidationError` check rather than importing Zod directly.
 *
 * On success the parsed (and transformed) value is returned unchanged.
 *
 * @param schema        - The Zod schema to validate against.
 * @param value         - The raw, untrusted input.
 * @param validatorName - A short label (e.g. `"StarknetAddress"`) that appears
 *   in the log payload to identify which schema rejected the input.
 * @returns The schema's output type `T`.
 * @throws {ValidationError} when `schema` rejects `value`.
 *
 * @example
 * const address = loggedParse(StarknetAddress, req.params.address, "StarknetAddress");
 */
export function loggedParse<T>(schema: z.ZodSchema<T>, value: unknown, validatorName: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const metric: ValidationErrorMetric = {
      validator: validatorName,
      input: typeof value === "string" ? value.slice(0, 40) : String(value).slice(0, 40),
      error: result.error.issues.map((i) => i.message).join("; "),
      timestamp: new Date().toISOString(),
    };
    logValidationError(metric);
    throw new ValidationError(result.error, metric);
  }
  return result.data;
}

/**
 * Shared Zod schema for a Starknet address supplied as a path or query
 * parameter. Accepts a hex string of up to 64 hex characters (the felt width),
 * with or without a 0x prefix, and transforms it to the canonical lookup form
 * via {@link normalizeStarknetAddress}, so callers receive an address ready for
 * a database lookup. The 0x prefix is optional to match the canonical
 * normalizer; non-hex, oversized, or empty values are rejected before any
 * database or RPC call.
 *
 * @example
 * StarknetAddress.parse("0x4718F5a..."); // canonical normalized address
 * StarknetAddress.parse("abc");          // also accepted, normalized to 0x..0abc
 */
export const StarknetAddress = z
  .string()
  .trim()
  .regex(
    /^(0x)?[0-9a-fA-F]{1,64}$/,
    "must be a hex string of up to 64 hex characters, with an optional 0x prefix",
  )
  .transform((value) => normalizeStarknetAddress(value));

/**
 * Shared Zod schema for a numeric agreement identifier passed as a string. The
 * id is stored as text, so it stays a string but must contain only digits,
 * which keeps malformed identifiers out of the database query.
 */
export const AgreementId = z
  .string()
  .trim()
  .regex(/^\d+$/, "agreement_id must be a numeric string");

/** Largest page a list endpoint will return in a single response. */
export const MAX_PAGE_LIMIT = 100;

/** Page size used when the caller does not supply a usable limit. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Returns `true` when `value` is a plain, non-null, non-array object.
 *
 * Used by {@link parsePagination} to guard against non-object inputs (strings,
 * numbers, arrays) being silently cast to `Record<string, unknown>`. Those
 * inputs would produce `undefined` limit/offset lookups that happen to fall
 * back to defaults, but the explicit guard makes the intent clear to readers
 * and removes the implicit cast.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes "missing-like" values — an explicit `null` or empty string — to
 * `undefined` before delegating to Zod so the `.catch()` fallback engages.
 *
 * Without this normalization, Zod's `z.coerce.number()` coerces both `null`
 * and `""` to `0`, which passes `.int()` and is silently clamped to a limit
 * of `1`. That bypasses {@link DEFAULT_PAGE_LIMIT} and makes a request return
 * only one row — inconsistent with `undefined`, which correctly falls back to
 * the documented default. Treating `null`, `""`, and `undefined` uniformly
 * removes the inconsistency.
 */
function coerceNullOrEmptyToUndefined(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  return value;
}

/**
 * Parses and clamps pagination query parameters. Clamping happens server-side
 * so a client cannot request an unbounded, zero, or negative page: `limit` is
 * forced into `[1, MAX_PAGE_LIMIT]` and `offset` to `>= 0`. Missing or
 * non-numeric values fall back to safe defaults rather than failing the
 * request.
 *
 * This function **never throws** — any input shape returns a valid, finite
 * pair. Non-object inputs (strings, numbers, arrays, `null`, `undefined`) are
 * treated as if no pagination params were supplied and fall back to defaults.
 *
 * @param query - The request query object (`req.query`), or any value.
 * @returns `{ limit, offset }` — both finite integers within the documented
 *   bounds.
 *
 * @example
 * parsePagination({ limit: "5000" }); // { limit: 100, offset: 0 }
 * parsePagination({ offset: "-3" });  // { limit: 50, offset: 0 }
 * parsePagination("not-an-object");   // { limit: 50, offset: 0 }
 */
export function parsePagination(query: unknown): {
  limit: number;
  offset: number;
} {
  // Non-object inputs (strings, numbers, arrays, null, undefined) carry no
  // limit/offset keys. Treat them as an empty object so the defaults engage
  // rather than relying on a silent `as Record<string, unknown>` cast.
  const source: Record<string, unknown> = isPlainObject(query) ? query : {};

  const limitRaw = z.coerce
    .number()
    .int()
    .catch(DEFAULT_PAGE_LIMIT)
    .parse(coerceNullOrEmptyToUndefined(source.limit));
  const offsetRaw = z.coerce
    .number()
    .int()
    .catch(0)
    .parse(coerceNullOrEmptyToUndefined(source.offset));
  return {
    limit: Math.min(Math.max(limitRaw, 1), MAX_PAGE_LIMIT),
    offset: Math.max(offsetRaw, 0),
  };
}
