import crypto from "node:crypto";
import { eq, or, lt, isNotNull } from "drizzle-orm";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { sessions as sessionsTable } from "../db/schema.js";
import {
  incSessionMetric,
  setSessionGauge,
  logSessionEvent,
  SESSION_METRICS,
  SESSION_GAUGES,
  type SessionRejectionReason,
} from "./session-metrics.js";

const SESSION_TTL_MS = env.SESSION_TTL_MS;
const SESSION_MAX_TTL_MS = env.SESSION_MAX_TTL_MS;
// Do not write to DB to update lastSeen/expiresAt if it was updated less than 1 minute ago.
const SESSION_UPDATE_THRESHOLD_MS = 60 * 1000;
// How often the background sweeper purges expired/revoked sessions from the DB.
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;


/**
 * Creates a new session in PostgreSQL for the given wallet address.
 * Generates a random 24-byte hex token, hashes it with SHA-256 for database storage,
 * and sets sliding and absolute expires timestamps.
 *
 * Emits a `session.created` log line and bumps `session_created_total`.
 *
 * @param address - The Starknet wallet address
 * @returns The raw token (to return to the client) and the token expiry time
 */
export async function createSession(address: string) {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const familyId = crypto.randomUUID();
  const now = Date.now();
  const normalizedAddress = address.toLowerCase();

  try {
    await db.insert(sessionsTable).values({
      tokenHash,
      address: normalizedAddress,
      familyId,
      expiresAt: new Date(now + SESSION_TTL_MS),
      absoluteExpiresAt: new Date(now + SESSION_MAX_TTL_MS),
    });
  } catch (error) {
    logSessionEvent("error", "session.rejected", {
      reason: "db_error" as SessionRejectionReason,
      operation: "create",
      address: normalizedAddress,
      message: errorMessage(error),
    });
    throw error;
  }

  incSessionMetric(SESSION_METRICS.CREATED);
  logSessionEvent("info", "session.created", {
    address: normalizedAddress,
    expires_in_ms: SESSION_TTL_MS,
    absolute_expires_in_ms: SESSION_MAX_TTL_MS,
  });

  return { token, expires_in_ms: SESSION_TTL_MS };
}

/**
 * Verifies that a given token is valid for a wallet address, checking database existence,
 * expiration, and revocation status. If valid, updates lastSeen and slides the expiry.
 *
 * Every false return path emits a `session.rejected` log line with a bounded reason
 * code and bumps the matching metric counter. Successful validation emits
 * `session.validated` (debug) and bumps `session_validated_total`.
 *
 * @param address - The Starknet wallet address
 * @param token - The raw session token
 * @returns A promise resolving to true if valid, false otherwise
 */
export async function requireSession(address: string, token: string): Promise<boolean> {
  if (!token || !address) {
    recordRejection("missing_input", address);
    return false;
  }
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date();

  try {
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.tokenHash, tokenHash))
      .limit(1);

    if (!session) {
      recordRejection("unknown_token", address);
      return false;
    }
    if (session.revokedAt !== null) {
      recordRejection("revoked", address);
      return false;
    }
    if (session.rotatedAt !== null) {
      recordRejection("revoked", address);
      return false;
    }
    if (session.expiresAt.getTime() < now.getTime()) {
      recordRejection("expired_sliding", address);
      return false;
    }
    if (session.absoluteExpiresAt.getTime() < now.getTime()) {
      recordRejection("expired_absolute", address);
      return false;
    }
    if (session.address !== address.toLowerCase()) {
      recordRejection("address_mismatch", address);
      return false;
    }

    // Sliding expiry: extend TTL unless it exceeds the absolute limit
    let nextExpiresAtMs = now.getTime() + SESSION_TTL_MS;
    if (nextExpiresAtMs > session.absoluteExpiresAt.getTime()) {
      nextExpiresAtMs = session.absoluteExpiresAt.getTime();
    }

    // Only update database if lastSeen is not set or threshold has elapsed to reduce repeated write I/O
    const shouldUpdate =
      !session.lastSeen ||
      (now.getTime() - session.lastSeen.getTime() >= SESSION_UPDATE_THRESHOLD_MS);

    if (shouldUpdate) {
      await db
        .update(sessionsTable)
        .set({
          lastSeen: now,
          expiresAt: new Date(nextExpiresAtMs),
        })
        .where(eq(sessionsTable.tokenHash, tokenHash));
    }

    incSessionMetric(SESSION_METRICS.VALIDATED);
    logSessionEvent("debug", "session.validated", {
      address: address.toLowerCase(),
      next_expires_at: new Date(nextExpiresAtMs).toISOString(),
    });

    return true;
  } catch (error) {
    logSessionEvent("error", "session.rejected", {
      reason: "db_error" as SessionRejectionReason,
      operation: "require",
      address: address.toLowerCase(),
      message: errorMessage(error),
    });
    incSessionMetric(SESSION_METRICS.REJECTED);
    return false;
  }
}

/**
 * Revokes a session token by marking it as revoked in the database.
 *
 * Emits `session.revoked` and bumps `session_revoked_total`. An empty
 * token is treated as a no-op (no log, no metric) so callers can safely
 * invoke this from middleware that has already validated the token.
 *
 * @param token - The raw session token to revoke
 */
export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  // Hash for the address correlation in the log — we never log the raw token.
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const tokenHashShort = tokenHash.slice(0, 8);

  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(sessionsTable.tokenHash, tokenHash));

  incSessionMetric(SESSION_METRICS.REVOKED);
  logSessionEvent("info", "session.revoked", {
    kind: "single",
    token_hash_prefix: tokenHashShort,
  });
}

export type RotateResult =
  | { ok: true; token: string; expires_in_ms: number }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "reused"; familyId: string };

/**
 * Rotates a refresh (session) token: validates the presented token, issues a
 * brand-new one in the same token family, and marks the old one as rotated
 * so it can never be used again.
 *
 * If the presented token has ALREADY been rotated out (or already revoked),
 * this is treated as a compromise signal — someone is replaying a stale
 * token — and the entire token family is revoked immediately.
 *
 * Emits one of:
 *  - `session.rotated` (info) on success + bumps `session_rotated_total`
 *  - `session.reuse_detected` (warn) on reuse + bumps `session_reuse_detected_total`
 *  - `session.rejected` (warn) on invalid input/expired token + bumps `session_rejected_total`
 *
 * @param address - The Starknet wallet address
 * @param token - The raw refresh token being presented
 */
export async function rotateSession(address: string, token: string): Promise<RotateResult> {
  if (!token || !address) {
    recordRejection("missing_input", address);
    return { ok: false, reason: "invalid" };
  }
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const normalizedAddress = address.toLowerCase();

  try {
    return await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.tokenHash, tokenHash))
        .for("update")
        .limit(1);

      if (!session || session.address !== normalizedAddress) {
        recordRejection(session ? "address_mismatch" : "unknown_token", address);
        return { ok: false, reason: "invalid" };
      }

      // Fallback for rows created before this migration: treat the token itself
      // as the root of its own family so future rotations still chain correctly.
      const familyId = session.familyId ?? session.tokenHash;

      if (session.rotatedAt !== null || session.revokedAt !== null) {
        // Inline family revocation for transaction safety, replicating revokeFamily telemetry
        await tx
          .update(sessionsTable)
          .set({ revokedAt: now })
          .where(eq(sessionsTable.familyId, familyId));
          
        incSessionMetric(SESSION_METRICS.FAMILY_REVOKED);
        logSessionEvent("warn", "session.family_revoked", {
          family_id: familyId,
        });

        incSessionMetric(SESSION_METRICS.REUSE_DETECTED);
        logSessionEvent("warn", "session.reuse_detected", {
          address: normalizedAddress,
          family_id: familyId,
          had_rotated_at: session.rotatedAt !== null,
          had_revoked_at: session.revokedAt !== null,
        });
        
        return { ok: false, reason: "reused", familyId };
      }

      if (
        session.expiresAt.getTime() < now.getTime() ||
        session.absoluteExpiresAt.getTime() < now.getTime()
      ) {
        recordRejection(
          session.absoluteExpiresAt.getTime() < now.getTime() ? "expired_absolute" : "expired_sliding",
          address,
        );
        return { ok: false, reason: "invalid" };
      }

      const newToken = crypto.randomBytes(24).toString("hex");
      const newTokenHash = crypto.createHash("sha256").update(newToken).digest("hex");
      const nowMs = now.getTime();
      let newExpiresAtMs = nowMs + SESSION_TTL_MS;
      if (newExpiresAtMs > session.absoluteExpiresAt.getTime()) {
        newExpiresAtMs = session.absoluteExpiresAt.getTime();
      }

      // Issue the replacement before marking the old one rotated, so a failure
      // here leaves the old token intact instead of orphaning the session.
      await tx.insert(sessionsTable).values({
        tokenHash: newTokenHash,
        address: session.address,
        familyId,
        expiresAt: new Date(newExpiresAtMs),
        absoluteExpiresAt: session.absoluteExpiresAt,
      });

      await tx
        .update(sessionsTable)
        .set({ rotatedAt: now })
        .where(eq(sessionsTable.tokenHash, tokenHash));

      incSessionMetric(SESSION_METRICS.ROTATED);
      logSessionEvent("info", "session.rotated", {
        address: normalizedAddress,
        family_id: familyId,
        expires_in_ms: newExpiresAtMs - nowMs,
      });

      return { ok: true, token: newToken, expires_in_ms: newExpiresAtMs - nowMs };
    });
  } catch (error) {
    incSessionMetric(SESSION_METRICS.REJECTED);
    logSessionEvent("error", "session.rejected", {
      reason: "db_error",
      operation: "rotate",
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "invalid" };
  }
}

/**
 * Revokes every token in a rotation family (used when reuse of a stale,
 * already-rotated token is detected — a likely token-theft signal).
 *
 * Emits `session.family_revoked` (warn) and bumps `session_family_revoked_total`.
 *
 * @param familyId - The token family identifier
 */
export async function revokeFamily(familyId: string): Promise<void> {
  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(sessionsTable.familyId, familyId));

  incSessionMetric(SESSION_METRICS.FAMILY_REVOKED);
  logSessionEvent("warn", "session.family_revoked", {
    family_id: familyId,
  });
}

/**
 * Revokes every outstanding session/refresh token belonging to a user,
 * regardless of family. Used by the /auth/revoke endpoint (e.g. "sign out
 * everywhere" or an admin-triggered account lockdown).
 *
 * Emits `session.all_revoked` (info) and bumps `session_all_revoked_total`.
 *
 * @param address - The Starknet wallet address
 */
export async function revokeAllSessionsForAddress(address: string): Promise<void> {
  const normalizedAddress = address.toLowerCase();
  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(sessionsTable.address, normalizedAddress));

  incSessionMetric(SESSION_METRICS.ALL_REVOKED);
  logSessionEvent("info", "session.all_revoked", {
    address: normalizedAddress,
  });
}

/**
 * Removes every session whose TTL has elapsed or has been explicitly revoked.
 *
 * Emits `session.sweep_completed` (info) on success and bumps both
 * `session_sweep_runs_total` and `session_sweep_deleted_total`; emits
 * `session.sweep_failed` (error) on DB error and bumps
 * `session_sweeper_errors_total`.
 *
 * @param now - Optional timestamp override (default Date.now())
 * @returns A promise resolving to the number of rows deleted
 */
export async function sweepExpiredSessions(now: number = Date.now()): Promise<number> {
  const nowDate = new Date(now);
  try {
    const deleted = await db
      .delete(sessionsTable)
      .where(
        or(
          lt(sessionsTable.expiresAt, nowDate),
          lt(sessionsTable.absoluteExpiresAt, nowDate),
          isNotNull(sessionsTable.revokedAt),
        ),
      )
      .returning({ tokenHash: sessionsTable.tokenHash });
    const count = deleted.length;
    incSessionMetric(SESSION_METRICS.SWEEP_RUNS);
    incSessionMetric(SESSION_METRICS.SWEEP_DELETED, count);
    setSessionGauge(SESSION_GAUGES.LAST_SWEEP_DELETED, count);
    setSessionGauge(SESSION_GAUGES.LAST_SWEEP_AT_MS, now);
    logSessionEvent("info", "session.sweep_completed", {
      deleted: count,
      now: nowDate.toISOString(),
    });
    return count;
  } catch (error) {
    incSessionMetric(SESSION_METRICS.SWEEPER_ERRORS);
    logSessionEvent("error", "session.sweep_failed", {
      message: errorMessage(error),
    });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordRejection(reason: SessionRejectionReason, address: string | undefined): void {
  incSessionMetric(SESSION_METRICS.REJECTED);
  switch (reason) {
    case "unknown_token":
      incSessionMetric(SESSION_METRICS.REJECTED_UNKNOWN);
      break;
    case "address_mismatch":
      incSessionMetric(SESSION_METRICS.REJECTED_ADDRESS_MISMATCH);
      break;
    case "revoked":
      incSessionMetric(SESSION_METRICS.REJECTED_REVOKED);
      break;
    case "expired_sliding":
    case "expired_absolute":
      incSessionMetric(SESSION_METRICS.REJECTED_EXPIRED);
      break;
    // "missing_input" and "db_error" are bucketed only under the global
    // REJECTED counter; no per-reason counter to keep cardinality bounded.
  }
  logSessionEvent("warn", "session.rejected", {
    reason,
    address: address?.toLowerCase(),
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Periodically purge expired or revoked sessions so they do not accumulate in PostgreSQL.
// Unref'd so it never keeps the process alive; skipped under test.
/* v8 ignore start */
if (env.NODE_ENV !== "test") {
  setInterval(() => {
    sweepExpiredSessions().catch((err) => {
      incSessionMetric(SESSION_METRICS.SWEEPER_ERRORS);
      logSessionEvent("error", "session.sweeper_crashed", {
        message: errorMessage(err),
      });
    });
  }, SESSION_SWEEP_INTERVAL_MS).unref();
}
/* v8 ignore stop */
