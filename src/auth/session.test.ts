import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

// Force the session logger into line-based (non-JSON) output and lower the
// minimum level to "debug" so the new observability tests can grep for
// every lifecycle event (including `session.validated`, which is emitted at
// debug because it is high-volume). Production default is `LOG_FORMAT=json`
// at `LOG_LEVEL=info`; the line-based shape is exercised here.
vi.hoisted(() => {
  process.env.LOG_FORMAT = "";
  process.env.LOG_LEVEL = "debug";
});

const {
  dbMock,
  schemaMock,
  mockState,
  eqMock,
  orMock,
  ltMock,
  isNotNullMock,
} = vi.hoisted(() => {
  const mockState = {
    sessions: [] as any[],
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
    transaction: async (cb: (tx: any) => Promise<any>) => {
      return cb(db);
    },
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
    select: () => {
      const selectChain = {
        from: (table: any) => selectChain,
        where: (conditionFn: (row: any) => boolean) => {
          selectChain._conditionFn = conditionFn;
          return selectChain;
        },
        for: (mode: string) => selectChain,
        limit: (n: number) => {
          selectChain._limitVal = n;
          return selectChain;
        },
        _conditionFn: (() => true) as (row: any) => boolean,
        _limitVal: undefined as number | undefined,
        then: (resolve: any) => {
          const filtered = mockState.sessions.filter(selectChain._conditionFn);
          const result =
            selectChain._limitVal !== undefined
              ? filtered.slice(0, selectChain._limitVal)
              : filtered;
          return resolve(result);
        },
      };
      return selectChain;
    },
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

  return {
    dbMock: db,
    schemaMock: schema,
    mockState,
    eqMock,
    orMock,
    ltMock,
    isNotNullMock,
  };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("../db/schema.js", () => ({ sessions: schemaMock.sessions }));
vi.mock("drizzle-orm", () => ({
  eq: eqMock,
  or: orMock,
  lt: ltMock,
  isNotNull: isNotNullMock,
}));

import {
  createSession,
  requireSession,
  revokeSession,
  sweepExpiredSessions,
  rotateSession,
  revokeFamily,
  revokeAllSessionsForAddress,
} from "./session";
import {
  getSessionMetricsSnapshot,
  resetSessionMetrics,
  SESSION_METRICS,
  SESSION_GAUGES,
} from "./session-metrics";

describe("sessions", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockState.sessions = [];
    resetSessionMetrics();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Existing behavior tests (unchanged contract)
  // ---------------------------------------------------------------------------

  it("validates a token for its address (case-insensitive)", async () => {
    const { token } = await createSession("0xABCDEF");
    expect(await requireSession("0xabcdef", token)).toBe(true);
  });

  it("rejects an unknown token", async () => {
    expect(await requireSession("0xabc", "not-a-real-token")).toBe(false);
  });

  it("rejects a valid token used with a different address", async () => {
    const { token } = await createSession("0xaaa");
    expect(await requireSession("0xbbb", token)).toBe(false);
  });

  it("returns a real expires_in_ms instead of null", async () => {
    const { expires_in_ms } = await createSession("0x111");
    expect(expires_in_ms).toBeGreaterThan(0);
  });

  it("rejects and removes a session once its TTL elapses", async () => {
    const { token, expires_in_ms } = await createSession("0x222");
    vi.advanceTimersByTime(expires_in_ms + 1);
    expect(await requireSession("0x222", token)).toBe(false);
  });

  it("keeps a token valid at the exact expiry boundary", async () => {
    const { token, expires_in_ms } = await createSession("0x444");
    vi.advanceTimersByTime(expires_in_ms);
    expect(await requireSession("0x444", token)).toBe(true);
  });

  it("slides expiry forward each time a live session is used", async () => {
    const { token, expires_in_ms } = await createSession("0x333");
    vi.advanceTimersByTime(expires_in_ms - 1);
    expect(await requireSession("0x333", token)).toBe(true);
    vi.advanceTimersByTime(expires_in_ms - 1);
    expect(await requireSession("0x333", token)).toBe(true);
  });

  it("sweepExpiredSessions purges only expired/revoked entries and returns the count", async () => {
    const a = await createSession("0xa");
    const b = await createSession("0xb");
    vi.advanceTimersByTime(a.expires_in_ms + 1);
    const c = await createSession("0xc");
    await revokeSession(b.token); // revoke b
    expect(await sweepExpiredSessions()).toBe(2); // a (expired) and b (revoked)
    expect(await requireSession("0xc", c.token)).toBe(true);
  });

  it("persists only token hashes, never raw tokens", async () => {
    const { token } = await createSession("0xSecureUser");
    expect(mockState.sessions).toHaveLength(1);
    const stored = mockState.sessions[0];
    expect(stored.tokenHash).not.toBe(token);
    const hashed = crypto.createHash("sha256").update(token).digest("hex");
    expect(stored.tokenHash).toBe(hashed);
  });

  it("rejects a revoked session token", async () => {
    const { token } = await createSession("0xAddress");
    await revokeSession(token);
    expect(await requireSession("0xAddress", token)).toBe(false);
  });

  it("caps sliding expiry at the absolute expiry boundary", async () => {
    const { token } = await createSession("0xabc");
    // Standard session TTL is 24h, max absolute TTL is 7 days.
    // Slide it by accessing it every 12 hours for 6 days
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(12 * 60 * 60 * 1000);
      const ok = await requireSession("0xabc", token);
      expect(ok).toBe(true);
    }

    const stored = mockState.sessions[0];
    // Next expiresAt would normally be: 6 days + 24h = 7 days.
    // Let's verify it matches absoluteExpiresAt exactly.
    expect(stored.expiresAt.getTime()).toBe(stored.absoluteExpiresAt.getTime());
  });

  it("rejects a session after the absolute expiry boundary", async () => {
    const { token } = await createSession("0xabc");
    // Advance past 7 days limit
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1);

    const ok = await requireSession("0xabc", token);
    expect(ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Observability: structured logs
  // ---------------------------------------------------------------------------

  it("emits a session.created log on createSession", async () => {
    await createSession("0xLogCreate");
    const created = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.created"),
    );
    expect(created).toBeDefined();
    expect(consoleInfoSpy).toHaveBeenCalled();
  });

  it("emits a session.rejected warn log on an unknown token", async () => {
    await requireSession("0xabc", "no-such-token");
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.rejected"),
    );
    expect(rejected).toBeDefined();
    expect(rejected![0]).toContain("unknown_token");
  });

  it("emits a session.rejected warn log on an address mismatch", async () => {
    const { token } = await createSession("0xaaa");
    await requireSession("0xbbb", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("address_mismatch"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.rejected warn log on expired sliding TTL", async () => {
    const { token, expires_in_ms } = await createSession("0xsliding");
    vi.advanceTimersByTime(expires_in_ms + 1);
    await requireSession("0xsliding", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("expired_sliding"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.rejected warn log on expired absolute TTL", async () => {
    const { token } = await createSession("0xabsolute");
    // Forge a session row where the absolute cap has elapsed but the sliding
    // expiry has not. In production this state is reached when a previously
    // sliding session reaches its absolute cap; here we mutate the row
    // directly so the test does not need to wait the full 7 days.
    const stored = mockState.sessions[0];
    stored.expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h in future
    stored.absoluteExpiresAt = new Date(Date.now() - 1000); // 1s in past
    await requireSession("0xabsolute", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("expired_absolute"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.rejected warn log on a revoked token", async () => {
    const { token } = await createSession("0xrevoked");
    await revokeSession(token);
    consoleWarnSpy.mockClear();
    await requireSession("0xrevoked", token);
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("revoked"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.rejected warn log with missing_input when no token is provided", async () => {
    await requireSession("0xabc", "");
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("missing_input"),
    );
    expect(rejected).toBeDefined();
  });

  it("rotateSession returns invalid and logs missing_input when no token is provided", async () => {
    const result = await rotateSession("0xabc", "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
    const rejected = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("missing_input"),
    );
    expect(rejected).toBeDefined();
  });

  it("emits a session.validated debug log on successful requireSession", async () => {
    const { token } = await createSession("0xdebug");
    consoleDebugSpy.mockClear();
    await requireSession("0xdebug", token);
    const validated = consoleDebugSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.validated"),
    );
    expect(validated).toBeDefined();
  });

  it("emits a session.revoked info log on revokeSession", async () => {
    const { token } = await createSession("0xrevokeLog");
    consoleInfoSpy.mockClear();
    await revokeSession(token);
    const revoked = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.revoked"),
    );
    expect(revoked).toBeDefined();
    expect(revoked![0]).toContain("kind=single");
  });

  it("emits a session.family_revoked warn log on revokeFamily", async () => {
    consoleWarnSpy.mockClear();
    await revokeFamily("family-xyz");
    const revoked = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.family_revoked"),
    );
    expect(revoked).toBeDefined();
    expect(revoked![0]).toContain("family_id=family-xyz");
  });

  it("emits a session.all_revoked info log on revokeAllSessionsForAddress", async () => {
    consoleInfoSpy.mockClear();
    await revokeAllSessionsForAddress("0xAllRevoke");
    const revoked = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.all_revoked"),
    );
    expect(revoked).toBeDefined();
    expect(revoked![0]).toContain("address=0xallrevoke");
  });

  it("emits a session.rotated info log on successful rotateSession", async () => {
    const { token } = await createSession("0xrotate");
    consoleInfoSpy.mockClear();
    const result = await rotateSession("0xrotate", token);
    expect(result.ok).toBe(true);
    const rotated = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.rotated"),
    );
    expect(rotated).toBeDefined();
  });

  it("emits a session.reuse_detected warn log and revokes the family on reuse", async () => {
    const { token } = await createSession("0xreuse");
    const firstResult = await rotateSession("0xreuse", token);
    expect(firstResult.ok).toBe(true);
    consoleWarnSpy.mockClear();

    // Replay the original, already-rotated token.
    const secondResult = await rotateSession("0xreuse", token);
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok && secondResult.reason === "reused") {
      expect(secondResult.familyId).toBeDefined();
    }
    const reused = consoleWarnSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.reuse_detected"),
    );
    expect(reused).toBeDefined();
  });

  it("emits a session.sweep_completed info log on a successful sweep", async () => {
    const a = await createSession("0xsweep-a");
    await revokeSession(a.token);
    consoleInfoSpy.mockClear();
    const deleted = await sweepExpiredSessions();
    expect(deleted).toBe(1);
    const completed = consoleInfoSpy.mock.calls.find(([line]) =>
      typeof line === "string" && line.includes("session.sweep_completed"),
    );
    expect(completed).toBeDefined();
    expect(completed![0]).toContain("deleted=1");
  });

  it("never logs raw session tokens", async () => {
    const { token } = await createSession("0xSecureLog");
    await revokeSession(token);
    await sweepExpiredSessions();
    const allLogCalls = [
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleDebugSpy.mock.calls,
    ];
    for (const [line] of allLogCalls) {
      if (typeof line !== "string") continue;
      expect(line).not.toContain(token);
    }
  });

  // ---------------------------------------------------------------------------
  // Observability: metric counters
  // ---------------------------------------------------------------------------

  it("increments session_created_total on every createSession", async () => {
    await createSession("0xMetrics1");
    await createSession("0xMetrics2");
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.CREATED]).toBe(2);
  });

  it("increments session_validated_total on successful requireSession", async () => {
    const { token } = await createSession("0xMetricsValid");
    await requireSession("0xMetricsValid", token);
    await requireSession("0xMetricsValid", token);
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.VALIDATED]).toBe(2);
  });

  it("increments session_rejected_total and the matching reason counter on rejection", async () => {
    const { token } = await createSession("0xMetricsReject");
    await revokeSession(token);
    await requireSession("0xMetricsReject", token); // -> revoked
    await requireSession("0xMetricsReject", "bad-token"); // -> unknown_token
    const counters = getSessionMetricsSnapshot().counters;
    expect(counters[SESSION_METRICS.REJECTED]).toBe(2);
    expect(counters[SESSION_METRICS.REJECTED_REVOKED]).toBe(1);
    expect(counters[SESSION_METRICS.REJECTED_UNKNOWN]).toBe(1);
  });

  it("increments session_revoked_total on revokeSession", async () => {
    const { token } = await createSession("0xMetricsRevoke");
    await revokeSession(token);
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.REVOKED]).toBe(1);
  });

  it("does not increment session_revoked_total when revokeSession is called with empty token", async () => {
    await revokeSession("");
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.REVOKED] ?? 0).toBe(0);
  });

  it("increments session_rotated_total on successful rotation", async () => {
    const { token } = await createSession("0xMetricsRotate");
    const result = await rotateSession("0xMetricsRotate", token);
    expect(result.ok).toBe(true);
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.ROTATED]).toBe(1);
  });

  it("increments session_reuse_detected_total and session_family_revoked_total on reuse", async () => {
    const { token } = await createSession("0xMetricsReuse");
    const first = await rotateSession("0xMetricsReuse", token);
    expect(first.ok).toBe(true);
    const second = await rotateSession("0xMetricsReuse", token);
    expect(second.ok).toBe(false);
    const counters = getSessionMetricsSnapshot().counters;
    expect(counters[SESSION_METRICS.REUSE_DETECTED]).toBe(1);
    expect(counters[SESSION_METRICS.FAMILY_REVOKED]).toBe(1);
  });

  it("increments session_all_revoked_total on revokeAllSessionsForAddress", async () => {
    await revokeAllSessionsForAddress("0xMetricsAll");
    expect(getSessionMetricsSnapshot().counters[SESSION_METRICS.ALL_REVOKED]).toBe(1);
  });

  it("increments session_sweep_runs_total and session_sweep_deleted_total on a sweep", async () => {
    const a = await createSession("0xSweepA");
    await revokeSession(a.token);
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1); // absolute-expire a
    const before = getSessionMetricsSnapshot().counters;
    expect(before[SESSION_METRICS.SWEEP_DELETED] ?? 0).toBe(0);
    expect(before[SESSION_METRICS.SWEEP_RUNS] ?? 0).toBe(0);
    const deleted = await sweepExpiredSessions();
    expect(deleted).toBe(1);
    const after = getSessionMetricsSnapshot().counters;
    expect(after[SESSION_METRICS.SWEEP_RUNS]).toBe(1);
    expect(after[SESSION_METRICS.SWEEP_DELETED]).toBe(1);
  });

  it("throttles database writes on sliding expiration updates", async () => {
    const { token } = await createSession("0xThrottledAddress");
    expect(mockState.sessions).toHaveLength(1);
    const initialSession = { ...mockState.sessions[0] };
    expect(initialSession.lastSeen).toBeNull();

    // First requireSession validation: should write/update lastSeen
    vi.advanceTimersByTime(10 * 1000); // 10 seconds in
    const ok1 = await requireSession("0xThrottledAddress", token);
    expect(ok1).toBe(true);

    const firstUpdateSession = { ...mockState.sessions[0] };
    expect(firstUpdateSession.lastSeen).not.toBeNull();
    const firstLastSeenMs = firstUpdateSession.lastSeen.getTime();
    expect(firstLastSeenMs).toBe(10 * 1000);

    // Second requireSession validation (within 1 minute threshold, e.g. +20 seconds): should NOT write/update lastSeen
    vi.advanceTimersByTime(20 * 1000); // 30 seconds total
    const ok2 = await requireSession("0xThrottledAddress", token);
    expect(ok2).toBe(true);

    const secondUpdateSession = { ...mockState.sessions[0] };
    expect(secondUpdateSession.lastSeen.getTime()).toBe(firstLastSeenMs); // remains 10 seconds

    // Third requireSession validation (past 1 minute threshold, e.g. +65 seconds): should write/update lastSeen
    vi.advanceTimersByTime(45 * 1000); // 75 seconds total (65 seconds since lastSeen)
    const ok3 = await requireSession("0xThrottledAddress", token);
    expect(ok3).toBe(true);

    const thirdUpdateSession = { ...mockState.sessions[0] };
    expect(thirdUpdateSession.lastSeen.getTime()).toBe(75 * 1000); // updated to 75 seconds
  });

  it("updates session_sweeper_last_deleted_count gauge after a sweep", async () => {
    const a = await createSession("0xGaugeA");
    await revokeSession(a.token);
    await sweepExpiredSessions();
    expect(getSessionMetricsSnapshot().gauges[SESSION_GAUGES.LAST_SWEEP_DELETED]).toBe(1);
  });

  it("resetSessionMetrics zeros every counter and gauge", async () => {
    await createSession("0xReset");
    const before = getSessionMetricsSnapshot();
    expect(Object.keys(before.counters).length).toBeGreaterThan(0);
    resetSessionMetrics();
    const after = getSessionMetricsSnapshot();
    expect(after.counters).toEqual({});
    expect(after.gauges).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Observability: failure path
  // ---------------------------------------------------------------------------

  it("emits a session.sweep_failed error log and bumps the sweeper error counter when the DB throws", async () => {
    const originalDelete = dbMock.delete;
    dbMock.delete = () => {
      throw new Error("synthetic DB failure");
    };
    try {
      const deleted = await sweepExpiredSessions();
      expect(deleted).toBe(0);
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.SWEEPER_ERRORS]).toBe(1);
      const failed = consoleErrorSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.sweep_failed"),
      );
      expect(failed).toBeDefined();
    } finally {
      dbMock.delete = originalDelete;
    }
  });

  it("emits a session.rejected error log with reason=db_error when requireSession's DB throws", async () => {
    const originalSelect = dbMock.select;
    dbMock.select = () => {
      throw new Error("synthetic require failure");
    };
    try {
      const ok = await requireSession("0xDbErr", "any-token");
      expect(ok).toBe(false);
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.REJECTED]).toBe(1);
      const failed = consoleErrorSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.rejected"),
      );
      expect(failed).toBeDefined();
      expect(failed![0]).toContain("db_error");
    } finally {
      dbMock.select = originalSelect;
    }
  });

  it("emits a session.rejected error log with operation=create when createSession's DB throws", async () => {
    const originalInsert = dbMock.insert;
    dbMock.insert = () => ({
      values: async () => {
        throw new Error("synthetic create failure");
      },
    });
    try {
      await expect(createSession("0xDbCreate")).rejects.toThrow(
        "synthetic create failure",
      );
      const counters = getSessionMetricsSnapshot().counters;
      expect(counters[SESSION_METRICS.CREATED] ?? 0).toBe(0);
      expect(counters[SESSION_METRICS.REJECTED]).toBe(1);
      const failed = consoleErrorSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.includes("session.rejected"),
      );
      expect(failed).toBeDefined();
      expect(failed![0]).toContain("db_error");
      expect(failed![0]).toContain("operation=create");
    } finally {
      dbMock.insert = originalInsert;
    }
  });
});
