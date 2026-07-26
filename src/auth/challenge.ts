import crypto from "node:crypto";
import { shortString, type TypedData } from "starknet";

export type ChallengeRecord = {
  nonce: string;
  expiresAtMs: number;
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Challenges are short-lived (5-minute TTL), cryptographic nonces used to prove wallet ownership.
 *
 * RATIONALE FOR IN-MEMORY RETENTION:
 * Challenges are highly transient. Storing them in-memory avoids unnecessary DB read/write overhead
 * for every unauthenticated challenge request. If the server restarts or a different instance
 * handles the verification, the user's wallet client simply requests a new challenge nonce with no
 * negative security implications and minimal user friction.
 *
 * INVARIANTS:
 * - At most ONE active (non-expired) challenge per address at any time. Issuing a new one for
 *   an address that already has an active entry is an idempotent replay — it returns the
 *   existing nonce and does NOT push the TTL forward.
 * - The Map key is always the lower-cased address, so mixed-case retries collide and map
 *   to the same entry. The TTL is anchored to the ORIGINAL creation time, never extended.
 *   This bounds the worst-case replay window even if the original nonce leaked.
 * - Lazy eviction: an entry only leaves the Map when (a) `consumeChallenge` reads it
 *   successfully (signature verified), (b) `getChallenge` or `consumeChallenge` discovers
 *   it has expired, or (c) `createChallenge` issues a fresh one on top of an expired entry.
 *   There is no background sweeper by design — see the "Out of scope" section below.
 */
export const challenges = new Map<string, ChallengeRecord>();

/**
 * Test hook. Clears the in-memory challenge Map. Production code MUST NOT call this
 * — there is no compensating action for a deliberately-cleared challenge, and a single
 * process eviction would invalidate any concurrent verify attempt for that address.
 *
 * Mirrors `clearBillingIdempotencyStore` in `src/routes/billing.ts`.
 */
export function clearChallengesForTesting(): void {
  challenges.clear();
}

/**
 * Generates a challenge nonce for verification, or returns the active one if one already
 * exists for this address.
 *
 * Contract (idempotent on retry):
 * - If the address has an entry in the Map whose `expiresAtMs` is strictly in the future
 *   (relative to `Date.now()`), the EXISTING nonce is returned along with the time
 *   REMAINING on its TTL. A `challenge_replayed` metric is emitted instead of a fresh
 *   `challenge_created`. This makes the `/auth/challenge` endpoint retry-safe: a
 *   duplicated request cannot accidentally invalidate an in-flight verify attempt.
 * - If the address has no entry, OR has an expired entry (lazy-evicted), a fresh nonce
 *   is generated, stored, and returned, with `expires_in_ms === CHALLENGE_TTL_MS`.
 * - The TTL is NEVER pushed forward on a replay. Anchoring it to the original creation
 *   time caps the worst-case replay window at one TTL regardless of how many retries
 *   the client (or a network midpoint) retransmits.
 *
 * @param address - The user's Starknet wallet address
 * @returns The same nonce as the active challenge (replay) or a fresh one; the time
 *   remaining on the challenge TTL.
 */
export function createChallenge(address: string) {
  const key = address.toLowerCase();
  const now = Date.now();
  const existing = challenges.get(key);

  if (existing && existing.expiresAtMs > now) {
    const remainingMs = existing.expiresAtMs - now;
    console.info(
      JSON.stringify({
        metric: "challenge_replayed",
        address: key,
        expires_in_ms: remainingMs,
        timestamp: new Date().toISOString(),
      }),
    );
    return { nonce: existing.nonce, expires_in_ms: remainingMs };
  }

  // Either there is no entry, or the entry exists but has already expired. Lazy-evict
  // the expired entry so we don't keep a dead record around.
  if (existing) {
    challenges.delete(key);
  }

  const nonce = `0x${crypto.randomBytes(16).toString("hex")}`;
  const expiresAtMs = now + CHALLENGE_TTL_MS;
  challenges.set(key, { nonce, expiresAtMs });

  console.info(
    JSON.stringify({
      metric: "challenge_created",
      address: key,
      expires_in_ms: CHALLENGE_TTL_MS,
      timestamp: new Date().toISOString(),
    }),
  );

  return { nonce, expires_in_ms: CHALLENGE_TTL_MS };
}

/**
 * Retrieves the challenge record for verification.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if found and valid, otherwise null
 */
export function getChallenge(address: string) {
  const key = address.toLowerCase();
  const rec = challenges.get(key);
  if (!rec) {
    console.info(
      JSON.stringify({
        metric: "challenge_miss",
        reason: "not_found",
        address: key,
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }

  if (Date.now() > rec.expiresAtMs) {
    challenges.delete(key);
    console.info(
      JSON.stringify({
        metric: "challenge_expired",
        address: key,
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
  return rec;
}

/**
 * Clears a challenge once verified.
 *
 * @param address - The user's Starknet wallet address
 */
export function clearChallenge(address: string) {
  const key = address.toLowerCase();
  const deleted = challenges.delete(key);
  if (deleted) {
    console.info(
      JSON.stringify({
        metric: "challenge_cleared",
        address: key,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Atomically reads and deletes the challenge for an address in a single step.
 *
 * This must be used (instead of getChallenge + a later clearChallenge) anywhere a
 * challenge is about to be verified. getChallenge is read-only, so if it's read at
 * the start of an async verification and only cleared afterwards, two concurrent
 * requests can both read the same still-valid nonce before either one clears it —
 * letting the same challenge be consumed twice (a replay bypass). Deleting it at
 * read time closes that gap: the second concurrent caller sees it already gone.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if it existed and was still valid, otherwise null
 */
export function consumeChallenge(address: string) {
  const rec = getChallenge(address);
  if (!rec) return null;

  challenges.delete(address.toLowerCase());
  console.info(
    JSON.stringify({
      metric: "challenge_consumed",
      address: address.toLowerCase(),
      timestamp: new Date().toISOString(),
    }),
  );

  return rec;
}

/**
 * Builds the SNIP-12 typed-data challenge a wallet signs to prove ownership.
 *
 * Extracted from the auth route so it can be unit-tested in isolation, without
 * pulling in the Express router or the Starknet RPC provider.
 */
export function buildTypedChallenge(address: string, chainId: string, nonce: string): TypedData {
  // Wallets (ArgentX/Braavos) validate typed data using a JSON schema.
  // They expect plain string values like:
  // - domain.chainId: "SN_SEPOLIA" / "SN_MAIN"
  // - domain.name/version: plain string
  // - message.action: plain string
  // (starknet.js will encode these according to the declared `felt` types when hashing/verifying)
  const chainIdLabel = shortString.decodeShortString(chainId);
  return {
    types: {
      StarknetDomain: [
        { name: "name", type: "felt" },
        { name: "version", type: "felt" },
        { name: "chainId", type: "felt" },
        // SNIP-12 domain revision (some wallets, e.g. Ready, require it)
        { name: "revision", type: "felt" },
      ],
      Challenge: [
        { name: "action", type: "felt" },
        { name: "wallet", type: "felt" },
        { name: "nonce", type: "felt" },
      ],
    },
    primaryType: "Challenge",
    domain: {
      name: "StelloPay",
      version: "1",
      chainId: chainIdLabel,
      revision: "1",
    },
    message: {
      action: "LOGIN",
      wallet: address,
      nonce,
    },
  };
}
