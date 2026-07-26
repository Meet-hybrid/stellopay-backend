import { shortString, type TypedData } from "starknet";

// ---------------------------------------------------------------------------
// SNIP-12 type definitions — constant across all challenges.
// Declared once at module level so they are never re-created per-request.
// ---------------------------------------------------------------------------

const CHALLENGE_TYPES: TypedData["types"] = {
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
};

// ---------------------------------------------------------------------------
// Chain-ID decode cache
// ---------------------------------------------------------------------------

/**
 * Memoised mapping from encoded chain-ID felt → human-readable label.
 *
 * `shortString.decodeShortString` is a pure, deterministic function: the same
 * felt always produces the same label. The felt is fixed for the lifetime of
 * the process (it comes from `getCachedNetworkInfo` which caches the first RPC
 * response). Caching the decoded result eliminates the repeated decode work on
 * every `/auth/challenge` and `/auth/verify` request.
 *
 * The cache is a plain `Map` rather than a WeakMap because the keys are
 * primitive strings. It is intentionally module-scoped so it survives across
 * requests but can be inspected or cleared in tests via {@link clearChainIdCache}.
 */
const chainIdCache = new Map<string, string>();

/**
 * Decode an encoded chain-ID felt to its human-readable label, using a
 * module-level cache so the decode only happens once per unique felt value.
 *
 * @param chainId - The encoded felt string returned by the Starknet RPC
 *   (e.g. the result of `shortString.encodeShortString("SN_SEPOLIA")`).
 * @returns The decoded label, e.g. `"SN_SEPOLIA"`.
 */
export function getChainIdLabel(chainId: string): string {
  let label = chainIdCache.get(chainId);
  if (label === undefined) {
    label = shortString.decodeShortString(chainId);
    chainIdCache.set(chainId, label);
  }
  return label;
}

/**
 * Clear the chain-ID decode cache.
 *
 * Only intended for use in tests that need to verify the caching behaviour
 * or that construct unusual chainId values. Production code must not call this.
 */
export function clearChainIdCache(): void {
  chainIdCache.clear();
}

// ---------------------------------------------------------------------------
// Typed-data builder
// ---------------------------------------------------------------------------

/**
 * Builds the SNIP-12 typed-data challenge a wallet signs to prove ownership.
 *
 * Extracted from the auth route so it can be unit-tested in isolation, without
 * pulling in the Express router or the Starknet RPC provider.
 *
 * ## Performance
 *
 * The `types` object is a module-level constant shared across all calls —
 * it never changes. The `chainId` label is decoded once per unique felt value
 * via {@link getChainIdLabel} and then served from an in-memory cache, avoiding
 * repeated `shortString.decodeShortString` calls on every request. Only the
 * `message` fields (`wallet` and `nonce`) differ between calls.
 *
 * ## Wallets
 *
 * ArgentX/Braavos validate typed data using a JSON schema. They expect plain
 * string values like:
 * - `domain.chainId`: `"SN_SEPOLIA"` / `"SN_MAIN"`
 * - `domain.name` / `version`: plain strings
 * - `message.action`: plain string
 *
 * starknet.js encodes these according to the declared `felt` types when
 * hashing/verifying.
 *
 * @param address - The wallet address that will sign the challenge.
 * @param chainId - The encoded chain-ID felt from the Starknet RPC provider.
 * @param nonce - A unique per-challenge nonce string.
 * @returns A SNIP-12 {@link TypedData} object ready for wallet signing.
 */
export function buildTypedChallenge(address: string, chainId: string, nonce: string): TypedData {
  return {
    types: CHALLENGE_TYPES,
    primaryType: "Challenge",
    domain: {
      name: "StelloPay",
      version: "1",
      chainId: getChainIdLabel(chainId),
      revision: "1",
    },
    message: {
      action: "LOGIN",
      wallet: address,
      nonce,
    },
  };
}
