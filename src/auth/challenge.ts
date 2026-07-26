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
 */
export const challenges = new Map<string, ChallengeRecord>();

/**
 * Generates a challenge nonce for verification.
 *
 * @param address - The user's Starknet wallet address
 * @returns The generated nonce and its TTL
 */
export function createChallenge(address: string) {
  const nonce = `0x${crypto.randomBytes(16).toString("hex")}`;
  challenges.set(address.toLowerCase(), { nonce, expiresAtMs: Date.now() + CHALLENGE_TTL_MS });
  
  // Structured log/metric for challenge generation
  console.info(JSON.stringify({
    metric: "challenge_created",
    address: address.toLowerCase(),
    expires_in_ms: CHALLENGE_TTL_MS,
    timestamp: new Date().toISOString()
  }));

  return { nonce, expires_in_ms: CHALLENGE_TTL_MS };
}

/**
 * Retrieves the challenge record for verification.
 *
 * @param address - The user's Starknet wallet address
 * @returns The challenge record if found and valid, otherwise null
 */
export function getChallenge(address: string) {
  const rec = challenges.get(address.toLowerCase());
  if (!rec) {
    console.info(JSON.stringify({
      metric: "challenge_miss",
      reason: "not_found",
      address: address.toLowerCase(),
      timestamp: new Date().toISOString()
    }));
    return null;
  }
  
  if (Date.now() > rec.expiresAtMs) {
    challenges.delete(address.toLowerCase());
    console.info(JSON.stringify({
      metric: "challenge_expired",
      address: address.toLowerCase(),
      timestamp: new Date().toISOString()
    }));
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
  const deleted = challenges.delete(address.toLowerCase());
  if (deleted) {
    console.info(JSON.stringify({
      metric: "challenge_cleared",
      address: address.toLowerCase(),
      timestamp: new Date().toISOString()
    }));
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
  console.info(JSON.stringify({
    metric: "challenge_consumed",
    address: address.toLowerCase(),
    timestamp: new Date().toISOString()
  }));
  
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
  // - domain.name/version: plain strings
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
