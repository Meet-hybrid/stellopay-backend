import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shortString } from "starknet";
import { 
  buildTypedChallenge,
  createChallenge,
  getChallenge,
  clearChallenge,
  consumeChallenge,
} from "./challenge";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// SN_SEPOLIA encoded as a felt short string, as the RPC provider returns it.
const chainId = shortString.encodeShortString("SN_SEPOLIA");

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
});

describe("challenge management & telemetry", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleInfoSpy.mockRestore();
  });

  it("issues an active challenge and logs creation", () => {
    const { nonce, expires_in_ms } = createChallenge("0xAbC");
    expect(nonce).toMatch(/^0x[0-9a-f]{32}$/);
    expect(expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(getChallenge("0xabc")?.nonce).toBe(nonce);
    
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_created"'));
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"address":"0xabc"'));
  });

  it("expires the challenge once the TTL elapses and logs expiry", () => {
    createChallenge("0xdead");
    consoleInfoSpy.mockClear();
    
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    expect(getChallenge("0xdead")).toBeNull();
    
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_expired"'));
  });

  it("logs a miss when retrieving a non-existent challenge", () => {
    expect(getChallenge("0xmissing")).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_miss"'));
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"reason":"not_found"'));
  });

  it("returns null after a challenge is cleared and logs clearing", () => {
    createChallenge("0xfeed");
    consoleInfoSpy.mockClear();
    
    clearChallenge("0xfeed");
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_cleared"'));
    
    expect(getChallenge("0xfeed")).toBeNull();
  });

  it("consumeChallenge returns the record exactly once, then null on reuse", () => {
    const { nonce } = createChallenge("0xC0FFEE");
    consoleInfoSpy.mockClear();
    
    const first = consumeChallenge("0xc0ffee");
    expect(first?.nonce).toBe(nonce);
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_consumed"'));
    
    consoleInfoSpy.mockClear();
    const second = consumeChallenge("0xc0ffee");
    expect(second).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_miss"'));
  });

  it("consumeChallenge rejects an expired challenge instead of returning it", () => {
    createChallenge("0xdeadbeef");
    consoleInfoSpy.mockClear();
    
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);
    expect(consumeChallenge("0xdeadbeef")).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_expired"'));
  });

  it("consumeChallenge deletes before any caller can read it again (closes the replay race)", () => {
    createChallenge("0xrace");
    consoleInfoSpy.mockClear();
    
    // Simulates two concurrent /auth/verify requests reading the same nonce:
    // only the first should ever see a non-null record.
    const attempt1 = consumeChallenge("0xrace");
    const attempt2 = consumeChallenge("0xrace");
    
    expect(attempt1).not.toBeNull();
    expect(attempt2).toBeNull(); // second fails because it's missing now
    expect(getChallenge("0xrace")).toBeNull();
    
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_consumed"'));
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('"metric":"challenge_miss"'));
  });

  // -------------------------------------------------------------------------
  // Expired-challenge sweep (bounds unbounded memory growth)
  //
  // getChallenge/consumeChallenge only evict an entry when it is *read*. An
  // address that requests a challenge and never calls /auth/verify (an
  // abandoned login, or an attacker enumerating addresses) would otherwise
  // never be cleaned up. Each test below imports a fresh module instance via
  // vi.resetModules() so its own sweep counter is isolated from the shared
  // top-level imports used elsewhere in this file.
  // -------------------------------------------------------------------------

  it("success path: does not evict a still-valid challenge even once the sweep interval is crossed", async () => {
    vi.resetModules();
    const mod = await import("./challenge");

    mod.createChallenge("0xstillvalid");
    // Cross the sweep interval with unrelated traffic.
    for (let i = 0; i < 50; i++) {
      mod.createChallenge(`0xfiller${i}`);
    }

    expect(mod.challenges.has("0xstillvalid")).toBe(true);
    expect(mod.getChallenge("0xstillvalid")).not.toBeNull();

    vi.resetModules();
  });

  it("boundary path: proactively evicts an expired challenge that was never read, once enough new challenges are created", async () => {
    vi.resetModules();
    const mod = await import("./challenge");

    mod.createChallenge("0xabandoned");
    expect(mod.challenges.has("0xabandoned")).toBe(true);

    // Let it expire without ever calling getChallenge/consumeChallenge on it —
    // lazy eviction-on-read never fires for this entry.
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);

    // Cross the sweep interval with unrelated traffic (none of it touching
    // "0xabandoned").
    for (let i = 0; i < 50; i++) {
      mod.createChallenge(`0xfiller${i}`);
    }

    expect(mod.challenges.has("0xabandoned")).toBe(false);

    vi.resetModules();
  });

  it("boundary path: the sweep leaves not-yet-expired entries in place, only removing ones past their TTL", async () => {
    vi.resetModules();
    const mod = await import("./challenge");

    mod.createChallenge("0xexpiring");
    // Advance partway through the TTL — not expired yet.
    vi.advanceTimersByTime(CHALLENGE_TTL_MS - 1);

    for (let i = 0; i < 50; i++) {
      mod.createChallenge(`0xfiller${i}`);
    }

    expect(mod.challenges.has("0xexpiring")).toBe(true);

    vi.resetModules();
  });
});
