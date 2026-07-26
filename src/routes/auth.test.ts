import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "node:crypto";

const { dbMock, schemaMock, mockState, eqMock, orMock, ltMock, isNotNullMock, mockProvider } = vi.hoisted(() => {
  const mockState = {
    sessions: [] as any[],
  };

  const mockProvider = {
    verifyMessageInStarknet: vi.fn(),
  };

 const schema = {
    sessions: {
      tokenHash: "tokenHash",
      address: "address",
      createdAt: "createdAt",
      expiresAt: "expiresAt",
      absoluteExpiresAt: "absoluteExpiresAt",
      revokedAt: "revokedAt",
      lastSeen: "lastSeen",
      familyId: "familyId",
      rotatedAt: "rotatedAt",
    },
  };

  const eqMock = (col: string, val: any) => (row: any) => row[col] === val;
  const orMock = (...fns: Array<(row: any) => boolean>) => (row: any) => fns.some((fn) => fn(row));
  const ltMock = (col: string, val: Date) => (row: any) =>
    row[col] instanceof Date ? row[col].getTime() < val.getTime() : false;
  const isNotNullMock = (col: string) => (row: any) =>
    row[col] !== null && row[col] !== undefined;

  const db = {
   insert: (table: any) => ({
      values: async (data: any) => {
        mockState.sessions.push({
          ...data,
          revokedAt: data.revokedAt || null,
          lastSeen: data.lastSeen || null,
          familyId: data.familyId || null,
          rotatedAt: data.rotatedAt || null,
        });
      },
    }),
    select: () => ({
      from: (table: any) => ({
        where: (conditionFn: (row: any) => boolean) => ({
          limit: (n: number) => {
            const filtered = mockState.sessions.filter(conditionFn);
            return {
              then: (resolve: any) => resolve(filtered.slice(0, n)),
            };
          },
        }),
      }),
    }),
    update: (table: any) => ({
      set: (updateData: any) => ({
        where: async (conditionFn: (row: any) => boolean) => {
          for (const row of mockState.sessions) {
            if (conditionFn(row)) {
              Object.assign(row, updateData);
            }
          }
        },
      }),
    }),
    delete: (table: any) => ({
      where: (conditionFn: (row: any) => boolean) => ({
        returning: async (returningFields: any) => {
          const matching: any[] = [];
          const remaining: any[] = [];
          for (const row of mockState.sessions) {
            if (conditionFn(row)) {
              matching.push(row);
            } else {
              remaining.push(row);
            }
          }
          mockState.sessions = remaining;
          return matching.map((row) => {
            const ret: any = {};
            for (const key of Object.keys(returningFields)) {
              ret[key] = row[key];
            }
            return ret;
          });
        },
      }),
    }),
  };

  return { dbMock: db, schemaMock: schema, mockState, eqMock, orMock, ltMock, isNotNullMock, mockProvider };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("../db/schema.js", () => ({ sessions: schemaMock.sessions }));
vi.mock("drizzle-orm", () => ({
  eq: eqMock,
  or: orMock,
  lt: ltMock,
  isNotNull: isNotNullMock,
}));

vi.mock("../starknet/client.js", () => ({
  provider: mockProvider,
  getCachedNetworkInfo: vi.fn().mockResolvedValue({ chainId: "0x534e5f5345504f4c4941" }),
}));

import { authRouter } from "./auth";
import { clearChallengesForTesting } from "../auth/challenge";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", authRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("Auth Routes Integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockState.sessions = [];
    vi.clearAllMocks();
    // The challenge Map is a process-global singleton in src/auth/challenge.ts.
    // Clear it between tests so order does not depend on which addresses were used.
    clearChallengesForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles the complete authentication lifecycle including challenge, verification, validation, and logout", async () => {
    const address = "0x123456789abcdef";
    const appInstance = makeApp();

    // 1. Request a challenge nonce
    const challengeRes = await request(appInstance)
      .post("/api/v1/auth/challenge")
      .send({ address });

    expect(challengeRes.status).toBe(200);
    expect(challengeRes.body.address).toBe(address);
    expect(challengeRes.body.nonce).toBeDefined();
    expect(challengeRes.body.expires_in_ms).toBe(300000);

    const nonce = challengeRes.body.nonce;

    // Mock Starknet verifyMessageInStarknet to succeed
    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);

    // 2. Verify challenge signature and create session
    const verifyRes = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({
        address,
        signature: ["0xsignature1", "0xsignature2"],
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.ok).toBe(true);
    expect(verifyRes.body.session_token).toBeDefined();
    expect(verifyRes.body.expires_in_ms).toBeDefined();

    const sessionToken = verifyRes.body.session_token;

    // Verify database only has the SHA-256 hash
    expect(mockState.sessions).toHaveLength(1);
    const storedSession = mockState.sessions[0];
    const expectedHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
    expect(storedSession.tokenHash).toBe(expectedHash);
    expect(storedSession.tokenHash).not.toBe(sessionToken);

    // 3. Validate session (valid token)
    const validateRes = await request(appInstance)
      .post("/api/v1/auth/session/validate")
      .send({
        address,
        session_token: sessionToken,
      });

    expect(validateRes.status).toBe(200);
    expect(validateRes.body.ok).toBe(true);
    expect(validateRes.body.address).toBe(address);

    // 4. Logout (revoke session)
    const logoutRes = await request(appInstance)
      .post("/api/v1/auth/logout")
      .set("x-user-address", address)
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.ok).toBe(true);

    // Verify revokedAt is set
    expect(storedSession.revokedAt).toBeInstanceOf(Date);

    // 5. Try to validate again (should fail because session is revoked)
    const validatePostLogoutRes = await request(appInstance)
      .post("/api/v1/auth/session/validate")
      .send({
        address,
        session_token: sessionToken,
      });

    expect(validatePostLogoutRes.status).toBe(401);
    expect(validatePostLogoutRes.body.ok).toBe(false);

    // 6. Try to logout again (should return 401 because session is revoked)
    const logoutPostLogoutRes = await request(appInstance)
      .post("/api/v1/auth/logout")
      .set("x-user-address", address)
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(logoutPostLogoutRes.status).toBe(401);
  });

  it("rejects verify once the challenge TTL has elapsed", async () => {
    const address = "0xExpiredChallenge";
    const appInstance = makeApp();

    const challengeRes = await request(appInstance)
      .post("/api/v1/auth/challenge")
      .send({ address });
    expect(challengeRes.status).toBe(200);

    vi.advanceTimersByTime(challengeRes.body.expires_in_ms + 1);

    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
    const verifyRes = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });

    expect(verifyRes.status).toBe(400);
    expect(verifyRes.body.error).toMatch(/No active challenge/);
  });

  it("rejects a replayed verify call reusing an already-consumed challenge", async () => {
    const address = "0xReplayAttempt";
    const appInstance = makeApp();

    const challengeRes = await request(appInstance)
      .post("/api/v1/auth/challenge")
      .send({ address });
    expect(challengeRes.status).toBe(200);

    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);

    const firstVerify = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });
    expect(firstVerify.status).toBe(200);
    expect(firstVerify.body.ok).toBe(true);

    // Replay: same address/signature submitted again after the challenge was consumed.
    const secondVerify = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });

    expect(secondVerify.status).toBe(400);
    expect(secondVerify.body.error).toMatch(/No active challenge/);
    // Only one session should have ever been created from the one valid challenge.
    expect(mockState.sessions).toHaveLength(1);
  });

  it("accepts a valid challenge exactly once, even when verify is attempted concurrently", async () => {
    const address = "0xConcurrentVerify";
    const appInstance = makeApp();

    const challengeRes = await request(appInstance)
      .post("/api/v1/auth/challenge")
      .send({ address });
    expect(challengeRes.status).toBe(200);

    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);

    // Fire two verify requests concurrently off the same still-valid challenge.
    const [res1, res2] = await Promise.all([
      request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] }),
      request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // Exactly one succeeds; the other finds the challenge already consumed.
    expect(statuses).toEqual([200, 400]);
    expect(mockState.sessions).toHaveLength(1);
  });

  it("returns 401 for unauthorized endpoints with generic message", async () => {
    const appInstance = makeApp();

    const logoutRes = await request(appInstance)
      .post("/api/v1/auth/logout")
      .set("x-user-address", "0xabc")
      .set("Authorization", "Bearer invalidtoken12345");

    expect(logoutRes.status).toBe(401);
    expect(logoutRes.body.error).toBe("Unauthorized");
  });

  it("rotates the refresh token on each call and invalidates the previous one", async () => {
    const address = "0xRotationHappyPath";
    const appInstance = makeApp();

    await request(appInstance).post("/api/v1/auth/challenge").send({ address });
    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
    const verifyRes = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });
    const firstToken = verifyRes.body.session_token;

    const refreshRes = await request(appInstance)
      .post("/api/v1/auth/refresh")
      .send({ address, refresh_token: firstToken });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.ok).toBe(true);
    const secondToken = refreshRes.body.refresh_token;
    expect(secondToken).toBeDefined();
    expect(secondToken).not.toBe(firstToken);

    // The old token no longer refreshes.
    const reuseOldRes = await request(appInstance)
      .post("/api/v1/auth/refresh")
      .send({ address, refresh_token: firstToken });
    expect(reuseOldRes.status).toBe(401);

    // The new token works.
    const refreshAgainRes = await request(appInstance)
      .post("/api/v1/auth/refresh")
      .send({ address, refresh_token: secondToken });
    expect(refreshAgainRes.status).toBe(200);
  });

  it("rejects reuse of a stale rotated refresh token and revokes the whole family", async () => {
    const address = "0xStaleReuseAttempt";
    const appInstance = makeApp();

    await request(appInstance).post("/api/v1/auth/challenge").send({ address });
    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
    const verifyRes = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });
    const firstToken = verifyRes.body.session_token;

    const refreshRes = await request(appInstance)
      .post("/api/v1/auth/refresh")
      .send({ address, refresh_token: firstToken });
    const secondToken = refreshRes.body.refresh_token;

    // Replay the stale, already-rotated first token (simulated theft).
    const reuseRes = await request(appInstance)
      .post("/api/v1/auth/refresh")
      .send({ address, refresh_token: firstToken });
    expect(reuseRes.status).toBe(401);

    // The whole family — including the legitimate current token — is now dead.
    const legitimateRefreshRes = await request(appInstance)
      .post("/api/v1/auth/refresh")
      .send({ address, refresh_token: secondToken });
    expect(legitimateRefreshRes.status).toBe(401);
  });

  it("revoke endpoint immediately invalidates outstanding tokens for that user", async () => {
    const address = "0xRevokeEverything";
    const appInstance = makeApp();

    await request(appInstance).post("/api/v1/auth/challenge").send({ address });
    mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
    const verifyRes = await request(appInstance)
      .post("/api/v1/auth/verify")
      .send({ address, signature: ["0xsig1", "0xsig2"] });
    const token = verifyRes.body.session_token;

    const revokeRes = await request(appInstance)
      .post("/api/v1/auth/revoke")
      .set("x-user-address", address)
      .set("Authorization", `Bearer ${token}`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.ok).toBe(true);

    const refreshAfterRevokeRes = await request(appInstance)
      .post("/api/v1/auth/refresh")
      .send({ address, refresh_token: token });
    expect(refreshAfterRevokeRes.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Idempotency contract (#195): login, challenge, and session issuance must
  // be safe to retry without producing ambiguous outcomes.
  // -----------------------------------------------------------------------
  describe("/auth/challenge idempotency", () => {
    it("returns the same nonce when retried within the active TTL window", async () => {
      const address = "0xChallengeRetry";
      const appInstance = makeApp();

      const first = await request(appInstance)
        .post("/api/v1/auth/challenge")
        .send({ address });
      expect(first.status).toBe(200);

      const second = await request(appInstance)
        .post("/api/v1/auth/challenge")
        .send({ address });

      expect(second.status).toBe(200);
      expect(second.body.nonce).toBe(first.body.nonce);
      expect(second.body.chain_id).toBe(first.body.chain_id);
      // TTL is anchored to the original issuance — no refresh on retry.
      expect(second.body.expires_in_ms).toBe(first.body.expires_in_ms);
      // Same nonce means the typed-data payload is also byte-equal.
      expect(second.body.typed_data).toEqual(first.body.typed_data);
    });

    it("issues a fresh nonce after the original challenge has expired", async () => {
      const address = "0xChallengeExpiredRetry";
      const appInstance = makeApp();

      const first = await request(appInstance)
        .post("/api/v1/auth/challenge")
        .send({ address });
      expect(first.status).toBe(200);

      vi.advanceTimersByTime(first.body.expires_in_ms + 1);

      const second = await request(appInstance)
        .post("/api/v1/auth/challenge")
        .send({ address });
      expect(second.status).toBe(200);
      expect(second.body.nonce).not.toBe(first.body.nonce);
      // Fresh TTL: a brand-new 5-minute window.
      expect(second.body.expires_in_ms).toBe(300000);
    });

    it("treats mixed-case address retries as the same challenge", async () => {
      const appInstance = makeApp();

      const first = await request(appInstance)
        .post("/api/v1/auth/challenge")
        .send({ address: "0xMixedCase" });
      const second = await request(appInstance)
        .post("/api/v1/auth/challenge")
        .send({ address: "0xMIXEDCASE" });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.nonce).toBe(first.body.nonce);
    });

    it("a retry after the challenge was consumed returns a brand-new nonce (consume is terminal)", async () => {
      const address = "0xChallengeConsumedThenRetried";
      const appInstance = makeApp();

      const first = await request(appInstance)
        .post("/api/v1/auth/challenge")
        .send({ address });
      mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
      const verify = await request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] });
      expect(verify.status).toBe(200);

      const retry = await request(appInstance)
        .post("/api/v1/auth/challenge")
        .send({ address });
      expect(retry.status).toBe(200);
      expect(retry.body.nonce).not.toBe(first.body.nonce);
    });
  });

  describe("session issuance idempotency (verify + refresh)", () => {
    it("two /auth/verify calls cannot both create a session off the same challenge", async () => {
      const address = "0xNoDoubleSession";
      const appInstance = makeApp();

      await request(appInstance).post("/api/v1/auth/challenge").send({ address });
      mockProvider.verifyMessageInStarknet.mockResolvedValue(true);

      const [a, b] = await Promise.all([
        request(appInstance)
          .post("/api/v1/auth/verify")
          .send({ address, signature: ["0xsig1", "0xsig2"] }),
        request(appInstance)
          .post("/api/v1/auth/verify")
          .send({ address, signature: ["0xsig1", "0xsig2"] }),
      ]);

      const okCount = [a, b].filter((r) => r.status === 200).length;
      const failCount = [a, b].filter((r) => r.status === 400).length;
      expect(okCount).toBe(1);
      expect(failCount).toBe(1);
      expect(mockState.sessions).toHaveLength(1);
    });

    it("/auth/session/validate is read-only and trivially idempotent on retry", async () => {
      const address = "0xValidateRetry";
      const appInstance = makeApp();

      await request(appInstance).post("/api/v1/auth/challenge").send({ address });
      mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
      const verify = await request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] });
      const token = verify.body.session_token;

      const r1 = await request(appInstance)
        .post("/api/v1/auth/session/validate")
        .send({ address, session_token: token });
      const r2 = await request(appInstance)
        .post("/api/v1/auth/session/validate")
        .send({ address, session_token: token });
      const r3 = await request(appInstance)
        .post("/api/v1/auth/session/validate")
        .send({ address, session_token: token });

      for (const r of [r1, r2, r3]) {
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.address).toBe(address);
      }
      // validate does not consume the session — still exactly one row.
      expect(mockState.sessions).toHaveLength(1);
    });

    it("/auth/refresh is deterministic per input token (replay of a rotated token fails closed)", async () => {
      const address = "0xRefreshDeterministic";
      const appInstance = makeApp();

      await request(appInstance).post("/api/v1/auth/challenge").send({ address });
      mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
      const verify = await request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] });
      const firstToken = verify.body.session_token;

      const r1 = await request(appInstance)
        .post("/api/v1/auth/refresh")
        .send({ address, refresh_token: firstToken });
      expect(r1.status).toBe(200);
      const secondToken = r1.body.refresh_token;

      // Replaying the stale first token deterministically fails (it was rotated).
      const replay = await request(appInstance)
        .post("/api/v1/auth/refresh")
        .send({ address, refresh_token: firstToken });
      expect(replay.status).toBe(401);
    });
  });

  describe("logout / revoke idempotency (already-revoked → 401, not an error)", () => {
    it("/auth/logout is idempotent for a still-valid session, and rejects a session that was already revoked", async () => {
      const address = "0xLogoutRetry";
      const appInstance = makeApp();

      await request(appInstance).post("/api/v1/auth/challenge").send({ address });
      mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
      const verify = await request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] });
      const token = verify.body.session_token;

      // First logout: ok.
      const first = await request(appInstance)
        .post("/api/v1/auth/logout")
        .set("x-user-address", address)
        .set("Authorization", `Bearer ${token}`);
      expect(first.status).toBe(200);

      // Second logout on the now-revoked session: 401, same generic envelope.
      // We deliberately do NOT return 200 here so that probes cannot distinguish
      // "session was already revoked" from "session never existed".
      const second = await request(appInstance)
        .post("/api/v1/auth/logout")
        .set("x-user-address", address)
        .set("Authorization", `Bearer ${token}`);
      expect(second.status).toBe(401);
      expect(second.body.error).toBe("Unauthorized");
    });

    it("/auth/revoke rejects a session that was already revoked", async () => {
      const address = "0xRevokeRetry";
      const appInstance = makeApp();

      await request(appInstance).post("/api/v1/auth/challenge").send({ address });
      mockProvider.verifyMessageInStarknet.mockResolvedValue(true);
      const verify = await request(appInstance)
        .post("/api/v1/auth/verify")
        .send({ address, signature: ["0xsig1", "0xsig2"] });
      const token = verify.body.session_token;

      const first = await request(appInstance)
        .post("/api/v1/auth/revoke")
        .set("x-user-address", address)
        .set("Authorization", `Bearer ${token}`);
      expect(first.status).toBe(200);

      const second = await request(appInstance)
        .post("/api/v1/auth/revoke")
        .set("x-user-address", address)
        .set("Authorization", `Bearer ${token}`);
      expect(second.status).toBe(401);
      expect(second.body.error).toBe("Unauthorized");
    });
  });
});