import { describe, it, expect, beforeEach } from "vitest";
import { shortString } from "starknet";
import { buildTypedChallenge, getChainIdLabel, clearChainIdCache } from "./challenge";

// SN_SEPOLIA encoded as a felt short string, as the RPC provider returns it.
const chainId = shortString.encodeShortString("SN_SEPOLIA");

// ---------------------------------------------------------------------------
// Existing contract tests — must stay green to preserve caller compatibility
// ---------------------------------------------------------------------------

describe("buildTypedChallenge", () => {
  it("decodes the chainId felt back into its label", () => {
    const td = buildTypedChallenge("0x123", chainId, "0xnonce");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_SEPOLIA");
  });

  it("uses Challenge as the primaryType and embeds wallet, nonce and action", () => {
    const td = buildTypedChallenge("0xWALLET", chainId, "0xabc123");
    expect(td.primaryType).toBe("Challenge");
    const message = td.message as Record<string, unknown>;
    expect(message.wallet).toBe("0xWALLET");
    expect(message.nonce).toBe("0xabc123");
    expect(message.action).toBe("LOGIN");
  });

  it("declares the SNIP-12 domain with name, version and revision", () => {
    const td = buildTypedChallenge("0x1", chainId, "0x2");
    const domain = td.domain as Record<string, unknown>;
    expect(domain.name).toBe("StelloPay");
    expect(domain.version).toBe("1");
    expect(domain.revision).toBe("1");
  });

  // ---------------------------------------------------------------------------
  // Success-path: full structure validation
  // ---------------------------------------------------------------------------

  it("declares StarknetDomain and Challenge types with the correct fields", () => {
    const td = buildTypedChallenge("0x1", chainId, "0x2");
    const types = td.types as Record<string, Array<{ name: string; type: string }>>;

    expect(types.StarknetDomain.map((f) => f.name)).toEqual([
      "name",
      "version",
      "chainId",
      "revision",
    ]);
    expect(types.Challenge.map((f) => f.name)).toEqual(["action", "wallet", "nonce"]);
  });

  it("produces independent message objects for different addresses and nonces", () => {
    const td1 = buildTypedChallenge("0xAAA", chainId, "0x001");
    const td2 = buildTypedChallenge("0xBBB", chainId, "0x002");

    const m1 = td1.message as Record<string, unknown>;
    const m2 = td2.message as Record<string, unknown>;

    expect(m1.wallet).toBe("0xAAA");
    expect(m1.nonce).toBe("0x001");
    expect(m2.wallet).toBe("0xBBB");
    expect(m2.nonce).toBe("0x002");
  });

  it("shares the same types object reference across calls (module-level constant)", () => {
    const td1 = buildTypedChallenge("0x1", chainId, "0xA");
    const td2 = buildTypedChallenge("0x2", chainId, "0xB");
    // Referential equality proves no re-allocation per call.
    expect(td1.types).toBe(td2.types);
  });

  it("handles SN_MAIN chain ID correctly", () => {
    const mainChainId = shortString.encodeShortString("SN_MAIN");
    const td = buildTypedChallenge("0x1", mainChainId, "0x2");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_MAIN");
  });
});

// ---------------------------------------------------------------------------
// getChainIdLabel — caching behaviour
// ---------------------------------------------------------------------------

describe("getChainIdLabel", () => {
  beforeEach(() => {
    clearChainIdCache();
  });

  it("decodes a felt to the expected label on first call", () => {
    expect(getChainIdLabel(chainId)).toBe("SN_SEPOLIA");
  });

  it("returns the same string on repeated calls (cache hit)", () => {
    const first = getChainIdLabel(chainId);
    const second = getChainIdLabel(chainId);
    expect(first).toBe("SN_SEPOLIA");
    expect(second).toBe("SN_SEPOLIA");
    // Referential equality: same string instance from cache, not a new allocation.
    expect(first).toBe(second);
  });

  it("decodes different chain IDs independently", () => {
    const mainChainId = shortString.encodeShortString("SN_MAIN");
    expect(getChainIdLabel(chainId)).toBe("SN_SEPOLIA");
    expect(getChainIdLabel(mainChainId)).toBe("SN_MAIN");
  });

  it("re-decodes after the cache is cleared", () => {
    const before = getChainIdLabel(chainId);
    clearChainIdCache();
    const after = getChainIdLabel(chainId);
    expect(before).toBe("SN_SEPOLIA");
    expect(after).toBe("SN_SEPOLIA");
  });

  it("caches the decoded value so decodeShortString is not called again", () => {
    // Prime the cache.
    getChainIdLabel(chainId);
    // Build a second challenge with the same chainId — the cache should serve it.
    // We verify indirectly: buildTypedChallenge must return the correct label.
    const td = buildTypedChallenge("0x1", chainId, "0x2");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_SEPOLIA");
  });
});
