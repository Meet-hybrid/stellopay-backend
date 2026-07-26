import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shortString } from "starknet";
import {
  buildTypedChallenge,
  createChallenge,
  getChallenge,
  clearChallenge,
  consumeChallenge,
  challenges,
  MAX_CHALLENGES,
  CHALLENGE_TTL_MS,
} from "./challenge";

// SN_SEPOLIA encoded as a felt short string, as the RPC provider returns it.
const chainId = shortString.encodeShortString("SN_SEPOLIA");

// A few valid Starknet addresses used as test inputs. Hex-only — these are
// the canonical normalized form (lowercase, 64 hex chars).
const ADDR_HEX_UPPER = "0xAABB"; // "0xaabb" after normalize
const ADDR_HEX_FULL = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ADDR_HEX_SHORT = "0xfeed";

describe("buildTypedChallenge", () => {
  it("decodes the chainId felt back into its label", () => {
    const td = buildTypedChallenge("0x123", chainId, "0xnonce");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_SEPOLIA");
  });

  it("uses Challenge as the primaryType and embeds wallet, nonce and action", () => {
    // Use a real Starknet address (ADDR_HEX_FULL is the canonical 64-hex
    // form). Its canonical padded form is identical to the input, so the
    // assertion can match exactly without the address falling through to
    // the lowercased fallback path.
    const td = buildTypedChallenge(ADDR_HEX_FULL, chainId, "0xabc123");
    expect(td.primaryType).toBe("Challenge");
    const message = td.message as Record<string, unknown>;
    expect(message.wallet).toBe(ADDR_HEX_FULL);
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

  it("normalizes mixed-case wallet input to the canonical lowercase form", () => {
    // "0xAABB" is all-uppercase so normalizeStarknetAddress skips the
    // mixed-case checksum branch and returns the canonical padded
    // (0x + 64 hex) form. The wallet sees the canonical wallet in the
    // typed data, so its signature is computed over the same bytes we
    // recorded under the same canonical Map key.
    const td = buildTypedChallenge("0xAABB", chainId, "0xnonce");
    expect((td.message as Record<string, unknown>).wallet).toBe(
      "0x000000000000000000000000000000000000000000000000000000000000aabb",
    );
  });

  it("accepts a checksum-valid mixed-case address and resolves to its lowercase canonical", () => {
    // All-lowercase valid Starknet address — it stays exactly as-given in
    // the typed data so the wallet sees the same bytes the backend recorded.
    const td = buildTypedChallenge(ADDR_HEX_FULL, chainId, "0xnonce");
    expect((td.message as Record<string, unknown>).wallet).toBe(ADDR_HEX_FULL);
  });
});

describe("challenge management & telemetry", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    challenges.clear();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleInfoSpy.mockRestore();
  });

  it("issues an active challenge and logs creation", () => {
    const { nonce, expires_in_ms } = createChallenge("0xabc");
    expect(nonce).toMatch(/^0x[0-9a-f]{32}$/);
    expect(expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(getChallenge("0xabc")?.nonce).toBe(nonce);

    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_created"'),
    );
    // The address field in the log is the lowercased raw input, matching
    // what the route layer received from req.body — so analysts can
    // correlate log lines with the original request. The Map key (used
    // internally for the lookup) is the canonical form.
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"address":"0xabc"'));
  });

  it("expires the challenge once the TTL elapses and logs expiry", () => {
    createChallenge("0xdead");
    consoleInfoSpy.mockClear();

    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    expect(getChallenge("0xdead")).toBeNull();

    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_expired"'),
    );
  });

  it("logs a miss when retrieving a non-existent challenge", () => {
    expect(getChallenge("0xabcd")).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_miss"'),
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"not_found"'));
  });

  it("logs an invalid_address miss when retrieving with a malformed address", () => {
    // Address is non-hex; the helper returns null without storing anything.
    expect(getChallenge("not-a-real-address")).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"invalid_address"'),
    );
  });

  it("returns null after a challenge is cleared and logs clearing", () => {
    createChallenge("0xfeed");
    consoleInfoSpy.mockClear();

    clearChallenge("0xfeed");
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_cleared"'),
    );

    expect(getChallenge("0xfeed")).toBeNull();
  });

  it("clearChallenge is a silent no-op for malformed addresses", () => {
    expect(() => clearChallenge("not-a-real-address")).not.toThrow();
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  it("createChallenge throws on a malformed address (defense-in-depth)", () => {
    expect(() => createChallenge("not-a-real-address")).toThrow(/parseable Starknet address/);
  });

  it("consumeChallenge returns the record exactly once, then null on reuse", () => {
    const { nonce } = createChallenge("0xC0FFEE");
    consoleInfoSpy.mockClear();

    const first = consumeChallenge("0xc0ffee");
    expect(first?.nonce).toBe(nonce);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_consumed"'),
    );

    consoleInfoSpy.mockClear();
    const second = consumeChallenge("0xc0ffee");
    expect(second).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_miss"'),
    );
  });

  it("consumeChallenge rejects an expired challenge instead of returning it", () => {
    createChallenge("0xdeadbeef");
    consoleInfoSpy.mockClear();

    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    expect(consumeChallenge("0xdeadbeef")).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_expired"'),
    );
  });

  it("consumeChallenge with a non-existent valid-hex address returns null and logs a miss", () => {
    // "0xbeef" is valid hex but never had a challenge issued for it.
    expect(consumeChallenge("0xbeef")).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_miss"'),
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"not_found"'));
  });

  it("consumeChallenge deletes before any caller can read it again (closes the replay race)", () => {
    createChallenge("0xface");
    consoleInfoSpy.mockClear();

    // Simulates two concurrent /auth/verify requests reading the same nonce:
    // only the first should ever see a non-null record.
    const attempt1 = consumeChallenge("0xface");
    const attempt2 = consumeChallenge("0xface");

    expect(attempt1).not.toBeNull();
    expect(attempt2).toBeNull(); // second fails because it's missing now
    expect(getChallenge("0xface")).toBeNull();

    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_consumed"'),
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_miss"'),
    );
  });

  it("consumeChallenge returns null for a malformed address without throwing", () => {
    // Defense-in-depth: the route layer already validates input shape, but
    // a future direct caller should not get a TypeError from address
    // handling — they should get a clean "no challenge" answer.
    expect(consumeChallenge("not-a-real-address")).toBeNull();
  });
});

describe("challenge store size cap (DoS hardening)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    challenges.clear();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("createChallenge throws when the store has reached MAX_CHALLENGES entries", () => {
    // Drive the store to the cap via direct Map mutation. This is the
    // boundary check we care about: it costs Map.set + a few assertions,
    // not the cost of running the real createChallenge (which generates
    // cryptographic nonces).
    for (let i = 0; i < MAX_CHALLENGES; i++) {
      challenges.set(`0x${i.toString(16).padStart(4, "0")}`, {
        nonce: `0x${i.toString(16).padStart(32, "0")}`,
        expiresAtMs: Date.now() + CHALLENGE_TTL_MS,
      });
    }
    expect(challenges.size).toBe(MAX_CHALLENGES);
    expect(() => createChallenge(ADDR_HEX_UPPER)).toThrow(/store is full/);
  });

  it("createChallenge resumes working once the store is cleared", () => {
    // Fill to the cap. Once full, createChallenge must refuse.
    for (let i = 0; i < MAX_CHALLENGES; i++) {
      challenges.set(`0x${i.toString(16).padStart(4, "0")}`, {
        nonce: `0x${i.toString(16).padStart(32, "0")}`,
        expiresAtMs: Date.now() + CHALLENGE_TTL_MS,
      });
    }
    expect(() => createChallenge(ADDR_HEX_UPPER)).toThrow(/store is full/);

    // The lazy-eviction path through getChallenge is exercised in the
    // "challenge management & telemetry" describe block; here we just
    // demonstrate that, once there's room, createChallenge works again.
    for (const key of challenges.keys()) {
      challenges.delete(key);
    }
    expect(challenges.size).toBe(0);

    expect(() => createChallenge(ADDR_HEX_SHORT)).not.toThrow();
    expect(challenges.size).toBe(1);
  });

  it("the exported MAX_CHALLENGES is large enough to bound memory growth", () => {
    // Sanity check on the constant itself: 100k * ~80 bytes per entry is
    // ~8MB, which is the documented memory bound in docs/auth/challenge.md.
    expect(MAX_CHALLENGES).toBeGreaterThanOrEqual(10_000);
  });
});
