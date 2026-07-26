import crypto from "node:crypto";
import { eq, or, lt, isNotNull } from "drizzle-orm";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { sessions as sessionsTable } from "../db/schema.js";

const SESSION_TTL_MS = env.SESSION_TTL_MS;
const SESSION_MAX_TTL_MS = env.SESSION_MAX_TTL_MS;
// How often the background sweeper purges expired/revoked sessions from the DB.
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;


/**
 * Creates a new session in PostgreSQL for the given wallet address.
 * Generates a random 24-byte hex token, hashes it with SHA-256 for database storage,
 * and sets sliding and absolute expires timestamps.
 *
 * @param address - The Starknet wallet address
 * @returns The raw token (to return to the client) and the token expiry time
 */
export async function createSession(address: string) {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const familyId = crypto.randomUUID();
  const now = Date.now();

  await db.insert(sessionsTable).values({
    tokenHash,
    address: address.toLowerCase(),
    familyId,
    expiresAt: new Date(now + SESSION_TTL_MS),
    absoluteExpiresAt: new Date(now + SESSION_MAX_TTL_MS),
  });

  return { token, expires_in_ms: SESSION_TTL_MS };
}

/**
 * Verifies that a given token is valid for a wallet address, checking database existence,
 * expiration, and revocation status. If valid, updates lastSeen and slides the expiry.
 *
 * @param address - The Starknet wallet address
 * @param token - The raw session token
 * @returns A promise resolving to true if valid, false otherwise
 */
export async function requireSession(address: string, token: string): Promise<boolean> {
  if (!token || !address) return false;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date();

  try {
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.tokenHash, tokenHash))
      .limit(1);

    if (!session) return false;
    if (session.revokedAt !== null) return false;
    if (session.rotatedAt !== null) return false;
    if (session.expiresAt.getTime() < now.getTime()) return false;
    if (session.absoluteExpiresAt.getTime() < now.getTime()) return false;
    if (session.address !== address.toLowerCase()) return false;

    // Sliding expiry: extend TTL unless it exceeds the absolute limit
    let nextExpiresAtMs = now.getTime() + SESSION_TTL_MS;
    if (nextExpiresAtMs > session.absoluteExpiresAt.getTime()) {
      nextExpiresAtMs = session.absoluteExpiresAt.getTime();
    }

    await db
      .update(sessionsTable)
      .set({
        lastSeen: now,
        expiresAt: new Date(nextExpiresAtMs),
      })
      .where(eq(sessionsTable.tokenHash, tokenHash));

    return true;
  } catch (error) {
    console.error("[auth] Database error in requireSession", error);
    return false;
  }
}

/**
 * Revokes a session token by marking it as revoked in the database.
 *
 * @param token - The raw session token to revoke
 */
export async function revokeSession(token: string): Promise<void> {

  if (!token) return;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(sessionsTable.tokenHash, tokenHash));
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
 * @param address - The Starknet wallet address
 * @param token - The raw refresh token being presented
 */
export async function rotateSession(address: string, token: string): Promise<RotateResult> {
  if (!token || !address) return { ok: false, reason: "invalid" };
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date();

  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.tokenHash, tokenHash))
    .limit(1);

  if (!session || session.address !== address.toLowerCase()) {
    return { ok: false, reason: "invalid" };
  }

  // Fallback for rows created before this migration: treat the token itself
  // as the root of its own family so future rotations still chain correctly.
  const familyId = session.familyId ?? session.tokenHash;

  if (session.rotatedAt !== null || session.revokedAt !== null) {
    await revokeFamily(familyId);
    return { ok: false, reason: "reused", familyId };
  }

  if (
    session.expiresAt.getTime() < now.getTime() ||
    session.absoluteExpiresAt.getTime() < now.getTime()
  ) {
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
  await db.insert(sessionsTable).values({
    tokenHash: newTokenHash,
    address: session.address,
    familyId,
    expiresAt: new Date(newExpiresAtMs),
    absoluteExpiresAt: session.absoluteExpiresAt,
  });

  await db
    .update(sessionsTable)
    .set({ rotatedAt: now })
    .where(eq(sessionsTable.tokenHash, tokenHash));

  return { ok: true, token: newToken, expires_in_ms: newExpiresAtMs - nowMs };
}

/**
 * Revokes every token in a rotation family (used when reuse of a stale,
 * already-rotated token is detected — a likely token-theft signal).
 *
 * @param familyId - The token family identifier
 */
export async function revokeFamily(familyId: string): Promise<void> {
  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(sessionsTable.familyId, familyId));
}

/**
 * Revokes every outstanding session/refresh token belonging to a user,
 * regardless of family. Used by the /auth/revoke endpoint (e.g. "sign out
 * everywhere" or an admin-triggered account lockdown).
 *
 * @param address - The Starknet wallet address
 */
export async function revokeAllSessionsForAddress(address: string): Promise<void> {
  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(sessionsTable.address, address.toLowerCase()));
}

/**
 * Removes every session whose TTL has elapsed or has been explicitly revoked.
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
    return deleted.length;
  } catch (error) {
    console.error("[auth] Database error in sweepExpiredSessions", error);
    return 0;
  }
}

// Periodically purge expired or revoked sessions so they do not accumulate in PostgreSQL.
// Unref'd so it never keeps the process alive; skipped under test.
/* v8 ignore start */
if (env.NODE_ENV !== "test") {
  setInterval(() => {
    sweepExpiredSessions().catch((err) => {
      console.error("[auth] Background sweeper failed", err);
    });
  }, SESSION_SWEEP_INTERVAL_MS).unref();
}
/* v8 ignore stop */