import { Request, Response, NextFunction } from "express";
import { requireSession } from "./session.js";
import { env } from "../config.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        address: string;
        token: string;
      };
    }
  }
}

// Header names this middleware relies on. Kept as module-level constants so
// tests, docs, and the runtime path share the same identifiers.
const USER_HEADER = "x-user-address";
const AUTH_HEADER = "authorization";
const BEARER_PREFIX = "Bearer ";

// Module-internal helpers, exported so the unit tests in this file can
// exercise them in isolation. They are NOT part of the public auth surface
// for other modules — callers outside `src/auth/middleware.ts` should
// depend on `requireAuth` / `requireAdmin` instead.

/**
 * Express types an HTTP header value as `string | string[] | undefined`.
 * Neither `x-user-address` nor `Authorization` is a list header: a repeated
 * value is a client mistake (or a probe). This helper reduces the runtime
 * shape to a trimmed single string or `null`, so the contract the rest of the
 * middleware operates on is "exactly one principal per request".
 *
 * Returns `null` for missing, empty, whitespace-only, or array-valued headers.
 */
export function readSingleHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parses the `Authorization` header into a raw bearer token. Strict by design:
 * the prefix `Bearer ` (case-sensitive, single space) must be present, and at
 * least one non-whitespace character must follow. Anything else — other
 * schemes (`Basic`, `Digest`, …), `bearer` in lower case, missing/empty
 * token, or only whitespace after the prefix — returns `null` and the caller
 * MUST reject the request as 401. The contract is "one raw session token,
 * one principal", with no OAuth scope parsing.
 *
 * Note: HTTP/1.1 (RFC 9110 §11.4.1 and RFC 6750 §2.1) treats the auth scheme
 * as case-insensitive. This middleware deliberately accepts the canonical
 * `Bearer ` only and locks the wire format. If you ever need to follow the
 * RFC more loosely, the change is intentionally local to this function.
 */
export function parseBearerToken(authHeader: string): string | null {
  if (!authHeader.startsWith(BEARER_PREFIX)) return null;
  const token = authHeader.substring(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Middleware that enforces a valid session for the request.
 *
 * Contract (single-principal, per request):
 *
 *   - Reads `x-user-address` and `Authorization` as SINGLE string values. A
 *     header that arrives as `string[]` (multi-valued) or that is empty /
 *     whitespace-only is rejected with 401 before any session lookup happens.
 *   - `Authorization` MUST be `Bearer <token>` with a non-empty token; other
 *     schemes are rejected.
 *   - The address is normalized (trim + lower-case) at this boundary exactly
 *     once, and the same normalized value is attached to `req.auth.address`.
 *     `requireSession` performs its own lower-case normalization for the
 *     session row comparison, so internal logs and row keys line up with the
 *     value downstream code sees.
 *   - On success: attaches `req.auth = { address, token }` and calls `next()`.
 *   - On every failure path (missing header, malformed header, unknown token,
 *     expired token, revoked token, or an unexpected throw): responds with
 *     `401 Unauthorized` and body `{ error: "Unauthorized" }`. The exact
 *     rejection reason is emitted by `requireSession` for ops/metrics only —
 *     no detail leaks to the client.
 *
 * Out of scope (intentionally):
 *
 *   - This middleware resolves EXACTLY ONE principal per request. It does not
 *     paginate, batch, or fan out across multiple addresses. Bulk principal
 *     resolution belongs to a separate, route-level contract (see the batch
 *     helpers in `src/routes/transactions.ts`, `src/routes/events.ts`,
 *     `src/routes/read.ts`, and `src/utils/validation.ts` for the
 *     established pagination/batching shapes in this codebase).
 *
 * @example success
 * headers: { "x-user-address": "0xUSER", "authorization": "Bearer abc" }
 * → req.auth = { address: "0xuser", token: "abc" }
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const rawAddress = readSingleHeader(req.headers[USER_HEADER]);
    if (rawAddress === null) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const rawAuth = readSingleHeader(req.headers[AUTH_HEADER]);
    if (rawAuth === null) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = parseBearerToken(rawAuth);
    if (token === null) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Note: requireSession lower-cases the address internally for its DB
    // comparison, so we pass the raw header value here. The normalized form
    // is the one downstream code reads on `req.auth.address`.
    const isValid = await requireSession(rawAddress, token);
    if (!isValid) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    req.auth = { address: rawAddress.toLowerCase(), token };
    next();
  } catch (error) {
    res.status(401).json({ error: "Unauthorized" });
  }
};

/**
 * Middleware that enforces admin-level access for the request.
 *
 * Contract:
 *
 *   - MUST be chained AFTER `requireAuth`. This middleware assumes `req.auth`
 *     has already been populated and `req.auth.address` is the normalized
 *     (trimmed, lower-cased) form `requireAuth` attached.
 *   - The principal MUST be present in the `ADMIN_ADDRESSES` env config. The
 *     config layer (`src/config.ts`) already trims, lower-cases, and drops
 *     empty entries when parsing the env, so a direct membership check is
 *     sufficient.
 *   - All failure paths respond with `401 Unauthorized` (not `403`) so the
 *     response is indistinguishable from an unauthenticated request and does
 *     not leak the admin allow-list or whether the address was a member.
 *   - Defensive type narrowing on `req.auth` protects against it not being
 *     the shape this layer attached — e.g. a middleware chain that bypassed
 *     `requireAuth`, hand-set `req.auth` in a test without normalization,
 *     or a future caller that attaches a value typed but not runtime-
 *     shaped like this file's `req.auth`.
 *
 * Like `requireAuth`, this resolves a SINGLE principal per request. There is
 * intentionally no `requireAdminForMany` or bulk variant here: bulk
 * authorization is a route-level concern, not a middleware one.
 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (
    !req.auth ||
    typeof req.auth.address !== "string" ||
    req.auth.address.length === 0
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // req.auth.address is already lower-cased by requireAuth; this is
  // defense-in-depth so this middleware remains safe if it is ever wired
  // without requireAuth or against a request whose req.auth was attached
  // by code that did not normalize.
  const userAddress = req.auth.address.toLowerCase();

  if (!env.ADMIN_ADDRESSES.includes(userAddress)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};
