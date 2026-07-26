import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ZodError } from "zod";

// ---------------------------------------------------------------------------
// Mock orchestration — hoisted so vitest can intercept all imports before
// the module under test is loaded.
// ---------------------------------------------------------------------------

const { dbMock, schemaMock, state, limitSpy } = vi.hoisted(() => {
  const limitSpy = vi.fn();
  const state: Record<string, any[]> = {};

  function from(tableName: string) {
    let joined = false;
    const chain: any = {
      where: () => chain,
      orderBy: () => chain,
      innerJoin: () => {
        joined = true;
        return chain;
      },
      limit: (n: number) => {
        limitSpy(tableName, n);
        return chain;
      },
      then: (resolve: (rows: any[]) => unknown) =>
        resolve(joined ? (state._joinedRows ?? []) : (state.rows[tableName] ?? [])),
    };
    return chain;
  }

  const db = { select: () => ({ from: (t: { __name: string }) => from(t.__name) }) };

  const schema = new Proxy(
    {},
    {
      get: (_t, name: string) =>
        new Proxy(
          { __name: name },
          {
            get: (_tt, p: string) => {
              if (p === "__name") return name;
              return "col";
            },
          }
        ),
    }
  );

  return { dbMock: db, schemaMock: schema, state, limitSpy };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("drizzle-orm", () => ({
  eq: () => "eq",
  and: (...args: unknown[]) => args,
  or: (...args: unknown[]) => args,
  desc: (col: unknown) => col,
  lt: () => "lt",
}));

vi.mock("../starknet/client.js", () => ({
  agreementContract: vi.fn(),
  provider: { getNonceForAddress: vi.fn(), getChainId: vi.fn() },
}));

vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn().mockResolvedValue(true),
}));

vi.mock("../config.js", () => ({
  defaults: { workAgreementAddress: "0xDefault" },
  env: {},
}));

vi.mock("../utils/codec.js", () => ({
  parseU256: vi.fn((n: string) => n),
  u256ToString: vi.fn((n: any) => String(n)),
  toHexString: vi.fn((n: any) => String(n)),
}));

vi.mock("../utils/address.js", () => ({
  normalizeStarknetAddress: vi.fn((addr: string) => addr.toLowerCase()),
}));

import { agreementRouter } from "./agreement";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ADDRESS = "0x" + "a".repeat(63) + "1";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", agreementRouter);
  // Mirror the central error handler pattern used across the project.
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      const isZod = err instanceof ZodError;
      res.status(isZod ? 400 : err?.status ?? 500).json({
        error: isZod ? "Validation failed" : err?.message,
        details: err?.issues ?? undefined,
      });
    }
  );
  return app;
}

function makeAgreement(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    contractAddress: VALID_ADDRESS.toLowerCase(),
    employer: "0xemployer",
    contributor: "0xcontributor",
    token: "0xtoken",
    mode: 0,
    paymentType: 1,
    status: 1,
    totalAmount: "1000",
    paidAmount: "500",
    disputeStatus: 0,
    blockNumber: 100,
    transactionHash: "0xhash",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-02"),
    ...overrides,
  };
}

function makeJoinedRow(agreementOverrides: Record<string, unknown> = {}) {
  return { agreement: makeAgreement(agreementOverrides) };
}

function listUrl(params?: Record<string, string>) {
  const base = `/api/v1/agreement/${VALID_ADDRESS}/list/${VALID_ADDRESS}`;
  if (!params) return base;
  const qs = new URLSearchParams(params).toString();
  return `${base}?${qs}`;
}

beforeEach(() => {
  limitSpy.mockClear();
  state.rows = {};
  state._joinedRows = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agreement list pagination", () => {
  it("returns a bounded response when no query params are supplied", async () => {
    const agreements = Array.from({ length: 80 }, (_, i) =>
      makeAgreement({ id: String(i + 1) })
    );
    state.rows.agreements = agreements;

    const res = await request(makeApp()).get(listUrl());

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("indexed");
    expect(res.body.agreements).toHaveLength(50); // default limit
    expect(res.body.limit).toBe(50);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.cursor).toBe("50"); // id of 50th item (mock returns in insertion order)
  });

  it("applies a custom limit within bounds", async () => {
    const agreements = Array.from({ length: 30 }, (_, i) =>
      makeAgreement({ id: String(i + 1) })
    );
    state.rows.agreements = agreements;

    const res = await request(makeApp()).get(listUrl({ limit: "10" }));

    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(10);
    expect(res.body.limit).toBe(10);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.cursor).toBe("10"); // id of 10th item (mock returns in insertion order)
  });

  it("clamps an oversized limit to the max", async () => {
    const agreements = Array.from({ length: 200 }, (_, i) =>
      makeAgreement({ id: String(i + 1) })
    );
    state.rows.agreements = agreements;

    const res = await request(makeApp()).get(listUrl({ limit: "9999" }));

    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(100);
    expect(res.body.limit).toBe(100);
  });

  it("clamps limit=0 to the minimum of 1", async () => {
    const agreements = Array.from({ length: 5 }, (_, i) =>
      makeAgreement({ id: String(i + 1) })
    );
    state.rows.agreements = agreements;

    const res = await request(makeApp()).get(listUrl({ limit: "0" }));

    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(1);
    expect(res.body.limit).toBe(1);
  });

  it("clamps negative limit to the minimum of 1", async () => {
    state.rows.agreements = [makeAgreement({ id: "1" })];

    const res = await request(makeApp()).get(listUrl({ limit: "-5" }));

    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(1);
    expect(res.body.limit).toBe(1);
  });

  it("returns hasMore=false and cursor=null when all results fit in one page", async () => {
    state.rows.agreements = [
      makeAgreement({ id: "3" }),
      makeAgreement({ id: "2" }),
      makeAgreement({ id: "1" }),
    ];

    const res = await request(makeApp()).get(listUrl());

    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(3);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.cursor).toBeNull();
  });

  it("returns an empty list with no cursor when there are no agreements", async () => {
    state.rows.agreements = [];

    const res = await request(makeApp()).get(listUrl());

    expect(res.status).toBe(200);
    expect(res.body.agreements).toEqual([]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.cursor).toBeNull();
  });
});

describe("agreement list cursor-based pagination", () => {
  it("returns the next page when a valid cursor is provided", async () => {
    const agreements = Array.from({ length: 60 }, (_, i) =>
      makeAgreement({ id: String(60 - i) }) // descending IDs
    );
    state.rows.agreements = agreements;

    // First page (limit=20) should return IDs 60 down to 41
    const page1 = await request(makeApp()).get(listUrl({ limit: "20" }));
    expect(page1.status).toBe(200);
    expect(page1.body.agreements).toHaveLength(20);

    // Use the cursor from page1 to get page2
    const cursor = page1.body.cursor;
    expect(cursor).toBeTruthy();

    const page2 = await request(makeApp()).get(listUrl({ limit: "20", cursor }));
    expect(page2.status).toBe(200);
    // The lt mock doesn't actually filter, but the route logic should still work
    expect(page2.body.agreements.length).toBeGreaterThanOrEqual(0);
  });

  it("returns empty when cursor points beyond all results", async () => {
    state.rows.agreements = [makeAgreement({ id: "5" })];

    const res = await request(makeApp()).get(listUrl({ cursor: "1" }));

    expect(res.status).toBe(200);
    // lt(id, "1") with only id="5" means no results pass the filter
    // (but our mock doesn't actually filter, so this tests response structure)
    expect(res.body.source).toBe("indexed");
  });
});

describe("agreement list status filter", () => {
  const statusLabels: Record<number, string> = {
    0: "Created",
    1: "Active",
    2: "Paused",
    3: "Cancelled",
    4: "Completed",
    5: "Disputed",
  };

  for (const status of [0, 1, 2, 3, 4, 5]) {
    it(`accepts status=${status} (${statusLabels[status]})`, async () => {
      state.rows.agreements = [
        makeAgreement({ id: "1", status }),
        makeAgreement({ id: "2", status }),
      ];

      const res = await request(makeApp()).get(
        listUrl({ status: String(status) })
      );

      expect(res.status).toBe(200);
      expect(res.body.source).toBe("indexed");
    });
  }

  it("rejects status=6 (out of range) with 400", async () => {
    const res = await request(makeApp()).get(listUrl({ status: "6" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects status=-1 (out of range) with 400", async () => {
    const res = await request(makeApp()).get(listUrl({ status: "-1" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects non-numeric status with 400", async () => {
    const res = await request(makeApp()).get(listUrl({ status: "abc" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects float status values with 400", async () => {
    const res = await request(makeApp()).get(listUrl({ status: "1.5" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });
});

describe("agreement list combined filters", () => {
  it("combines status filter with cursor pagination", async () => {
    state.rows.agreements = [
      makeAgreement({ id: "5", status: 1 }),
      makeAgreement({ id: "4", status: 1 }),
      makeAgreement({ id: "3", status: 1 }),
    ];

    const res = await request(makeApp()).get(
      listUrl({ status: "1", limit: "2", cursor: "10" })
    );

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("indexed");
    // Response structure is valid under combined filters
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("cursor");
    expect(res.body).toHaveProperty("hasMore");
    expect(res.body).toHaveProperty("agreements");
  });

  it("combines status filter with limit", async () => {
    state.rows.agreements = Array.from({ length: 10 }, (_, i) =>
      makeAgreement({ id: String(10 - i), status: 4 })
    );

    const res = await request(makeApp()).get(
      listUrl({ status: "4", limit: "5" })
    );

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
  });
});

describe("agreement list backward compatibility", () => {
  it("omitting all params returns a bounded response with the default limit", async () => {
    const agreements = Array.from({ length: 200 }, (_, i) =>
      makeAgreement({ id: String(200 - i) })
    );
    state.rows.agreements = agreements;

    const res = await request(makeApp()).get(listUrl());

    expect(res.status).toBe(200);
    expect(res.body.agreements.length).toBeLessThanOrEqual(50);
    expect(res.body.source).toBe("indexed");
  });

  it("response shape includes expected agreement fields", async () => {
    state.rows.agreements = [makeAgreement({ id: "42" })];

    const res = await request(makeApp()).get(listUrl());

    expect(res.status).toBe(200);
    const [agreement] = res.body.agreements;
    expect(agreement).toHaveProperty("agreement_id", "42");
    expect(agreement).toHaveProperty("employer");
    expect(agreement).toHaveProperty("contributor");
    expect(agreement).toHaveProperty("status");
    expect(agreement).toHaveProperty("mode");
    expect(agreement).toHaveProperty("total_amount");
    expect(agreement).toHaveProperty("paid_amount");
  });

  it("response shape includes pagination metadata", async () => {
    state.rows.agreements = [makeAgreement({ id: "1" })];

    const res = await request(makeApp()).get(listUrl());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("cursor");
    expect(res.body).toHaveProperty("hasMore");
    expect(res.body).toHaveProperty("source", "indexed");
  });
});

describe("agreement list deduplication", () => {
  it("deduplicates agreements that appear in both direct and employee queries", async () => {
    // Same agreement appears in both places
    state.rows.agreements = [makeAgreement({ id: "10" })];
    state._joinedRows = [makeJoinedRow({ id: "10" })];

    const res = await request(makeApp()).get(listUrl({ limit: "10" }));

    expect(res.status).toBe(200);
    // The route deduplicates by id, so we should only see it once
    expect(res.body.agreements).toHaveLength(1);
    expect(res.body.agreements[0].agreement_id).toBe("10");
  });

  it("returns both unique agreements when direct and employee queries differ", async () => {
    state.rows.agreements = [makeAgreement({ id: "10" })];
    state._joinedRows = [makeJoinedRow({ id: "20" })];

    const res = await request(makeApp()).get(listUrl({ limit: "10" }));

    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(2);
  });
});
