import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shortString } from "starknet";
import {
  buildTypedChallenge,
  createChallenge,
  getChallenge,
  clearChallenge,
  consumeChallenge,
  clearChallengesForTesting,
  challenges,
} from "./challenge";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// SN_SEPOLIA encoded as a felt short string, as the RPC provider returns it.
const chainIdSepolia = shortString.encodeShortString("SN_SEPOLIA");
// SN_MAIN encoded as a felt short string, exercising the alternate chain.
const chainIdMain = shortString.encodeShortString("SN_MAIN");

describe("buildTypedChallenge", () => {
  it("decodes the chainId felt back into its label", () => {
    const td = buildTypedChallenge("0x123", chainIdSepolia, "0xnonce");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_SEPOLIA");
  });

  it("decodes the mainnet chainId felt back into its label", () => {
    const td = buildTypedChallenge("0x123", chainIdMain, "0xnonce");
    expect((td.domain as Record<string, unknown>).chainId).toBe("SN_MAIN");
  });

  it("uses Challenge as the primaryType and embeds wallet, nonce and action", () => {
    const td = buildTypedChallenge("0xWALLET", chainIdSepolia, "0xabc123");
    expect(td.primaryType).toBe("Challenge");
    const message = td.message as Record<string, unknown>;
    expect(message.wallet).toBe("0xWALLET");
    expect(message.nonce).toBe("0xabc123");
    expect(message.action).toBe("LOGIN");
  });

  it("declares the SNIP-12 domain with name, version and revision", () => {
    const td = buildTypedChallenge("0x1", chainIdSepolia, "0x2");
    const domain = td.domain as Record<string, unknown>;
    expect(domain.name).toBe("StelloPay");
    expect(domain.version).toBe("1");
    expect(domain.revision).toBe("1");
  });

  it("declares both StarknetDomain and Challenge types with the expected felt fields", () => {
    const td = buildTypedChallenge("0x1", chainIdSepolia, "0x2");
    const types = td.types as Record<string, Array<{ name: string; type: string }>>;
    expect(types.StarknetDomain.map((f) => f.name)).toEqual([
      "name",
      "version",
      "chainId",
      "revision",
    ]);
    expect(types.Challenge.map((f) => f.name)).toEqual(["action", "wallet", "nonce"]);
    for (const fields of Object.values(types)) {
      for (const field of fields) {
        expect(field.type).toBe("felt");
      }
    }
  });
});

describe("challenge management & telemetry", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    clearChallengesForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleInfoSpy.mockRestore();
    clearChallengesForTesting();
  });

  it("issues an active challenge and logs creation", () => {
    const { nonce, expires_in_ms } = createChallenge("0xAbC");
    expect(nonce).toMatch(/^0x[0-9a-f]{32}$/);
    expect(expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(getChallenge("0xabc")?.nonce).toBe(nonce);

    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_created"'),
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"address":"0xabc"'),
    );
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

  it("returns the active record at the exact TTL boundary for getChallenge (strict >, not >=)", () => {
    const { expires_in_ms } = createChallenge("0xboundary");
    // Right at the boundary, Date.now() == expires_in_ms, which getChallenge
    // treats as STILL valid because the check is `>` (not `>=`).
    vi.setSystemTime(expires_in_ms);
    expect(getChallenge("0xboundary")?.nonce).toMatch(/^0x[0-9a-f]{32}$/);
    // One millisecond past the boundary, getChallenge treats the record as
    // expired and evicts it lazily.
    vi.setSystemTime(expires_in_ms + 1);
    expect(getChallenge("0xboundary")).toBeNull();
  });

  it("createChallenge issues a fresh nonce at the exact TTL boundary (does NOT replay)", () => {
    // Mirrors the getChallenge boundary test above but pins the asymmetric
    // behavior of createChallenge: at Date.now() === expires_in_ms, the strict
    // `>` check on the replay branch is false, so createChallenge falls
    // through to evict-and-create-fresh. The returned nonce therefore differs
    // from the original. getChallenge, by contrast, still returns the existing
    // record at the same boundary. This split is intentional and is what the
    // doc paragraph in docs/auth/challenge.md means by "strict `>` boundary".
    const first = createChallenge("0xboundary-create");
    vi.setSystemTime(first.expires_in_ms);

    consoleInfoSpy.mockClear();
    const second = createChallenge("0xboundary-create");

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_created"'),
    );
  });

  it("logs a miss when retrieving a non-existent challenge", () => {
    expect(getChallenge("0xmissing")).toBeNull();
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_miss"'),
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"not_found"'),
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

    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_consumed"'),
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_miss"'),
    );
  });
});

describe("createChallenge idempotency (#318, #195)", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    clearChallengesForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleInfoSpy.mockRestore();
    clearChallengesForTesting();
  });

  it("returns the same nonce on a retry while the active window is still open", () => {
    const first = createChallenge("0xretry");
    consoleInfoSpy.mockClear();

    const second = createChallenge("0xretry");

    expect(second.nonce).toBe(first.nonce);
    expect(second.expires_in_ms).toBe(first.expires_in_ms);
    // No new entry was created — the Map size is unchanged.
    expect(challenges.size).toBe(1);
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_replayed"'),
    );
    expect(consoleInfoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_created"'),
    );
  });

  it("returns a reduced expires_in_ms on replay after time has advanced (TTL is NOT pushed forward)", () => {
    const first = createChallenge("0xnorefresh");
    vi.advanceTimersByTime(30_000);
    consoleInfoSpy.mockClear();

    const second = createChallenge("0xnorefresh");

    expect(second.nonce).toBe(first.nonce);
    // TTL remaining = CHALLENGE_TTL_MS - 30_000, never CHALLENGE_TTL_MS again.
    expect(second.expires_in_ms).toBe(CHALLENGE_TTL_MS - 30_000);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_replayed"'),
    );
  });

  it("issues a fresh nonce after the prior challenge has expired (lazy-evict then create)", () => {
    const first = createChallenge("0xrotated");
    vi.advanceTimersByTime(CHALLENGE_TTL_MS + 1);

    consoleInfoSpy.mockClear();
    const second = createChallenge("0xrotated");

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_created"'),
    );
    expect(consoleInfoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_replayed"'),
    );
  });

  it("collapses mixed-case address retries onto a single Map entry", () => {
    const first = createChallenge("0xMixedCase");
    const second = createChallenge("0xMIXEDCASE");
    const third = createChallenge("0xmixedcase");

    expect(second.nonce).toBe(first.nonce);
    expect(third.nonce).toBe(first.nonce);
    expect(challenges.size).toBe(1);
    expect(challenges.has("0xmixedcase")).toBe(true);
  });

  it("treats different addresses as distinct challenges (replay isolation)", () => {
    const a = createChallenge("0xAlice");
    const b = createChallenge("0xBob");

    expect(a.nonce).not.toBe(b.nonce);
    expect(challenges.size).toBe(2);
    // Alice's active challenge is unaffected by Bob's create/clear cycle.
    clearChallenge("0xBob");
    expect(getChallenge("0xAlice")?.nonce).toBe(a.nonce);
  });

  it("a successful consume makes the slot reusable (next createChallenge issues a fresh nonce)", () => {
    const first = createChallenge("0xconsumed-then-reissued");
    consumeChallenge("0xconsumed-then-reissued");
    consoleInfoSpy.mockClear();

    const second = createChallenge("0xconsumed-then-reissued");

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.expires_in_ms).toBe(CHALLENGE_TTL_MS);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"metric":"challenge_created"'),
    );
  });
});