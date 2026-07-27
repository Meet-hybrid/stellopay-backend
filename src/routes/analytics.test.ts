import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const { dbMock, schemaMock, queryState } = vi.hoisted(() => {
  type TableName = "payments" | "escrowEvents" | "agreementEvents";

  const makeTable = (name: string) =>
    new Proxy(
      { __name: name },
      {
        get(_target, prop) {
          if (prop === "__name") return name;
          return { table: name, column: String(prop) };
        },
      },
    ) as { __name: string } & Record<string, unknown>;

  const schema = {
    payments: makeTable("payments"),
    escrowEvents: makeTable("escrowEvents"),
    agreementEvents: makeTable("agreementEvents"),
    agreements: makeTable("agreements"),
  };

  const state = {
    rows: {
      payments: [] as Array<Record<string, unknown>>,
      escrowEvents: [] as Array<Record<string, unknown>>,
      agreementEvents: [] as Array<Record<string, unknown>>,
    },
    eqValues: [] as string[],
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: { __name: TableName }) => {
        const rows = state.rows[table.__name] ?? [];
        return {
          where: vi.fn(() => Promise.resolve(rows)),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(rows)),
          })),
        };
      }),
    })),
  };

  return { dbMock: db, schemaMock: schema, queryState: state };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_column: unknown, value: unknown) => {
    if (typeof value === "string") queryState.eqValues.push(value);
    return { type: "eq", value };
  }),
  and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
  or: vi.fn((...conditions: unknown[]) => ({ type: "or", conditions })),
  gte: vi.fn(() => ({ type: "gte" })),
  lte: vi.fn(() => ({ type: "lte" })),
  sql: vi.fn(() => "sql-expr"),
}));

import { analyticsRouter } from "./analytics.js";
import { normalizeStarknetAddress } from "../utils/address.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", analyticsRouter);
  app.use(
    (
      err: { status?: number; message?: string; issues?: unknown },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const isZod = err instanceof ZodError;
      res.status(isZod ? 400 : (err.status ?? 500)).json({
        error: isZod ? "Validation failed" : (err.message ?? "Internal error"),
        details: isZod ? err.issues : undefined,
      });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryState.rows.payments = [];
  queryState.rows.escrowEvents = [];
  queryState.rows.agreementEvents = [];
  queryState.eqValues = [];
});

describe("analytics route", () => {
  it("validates and normalizes the address and returns twelve months of chart data", async () => {
    const address = normalizeStarknetAddress("abc");
    queryState.rows.payments = [{ month: 3, amount: "1000000", to: address }];
    queryState.rows.escrowEvents = [
      { month: 4, amount: "2000000", eventType: "Funded", employer: address },
      { month: 5, amount: "3000000", eventType: "Released", to: address },
    ];
    queryState.rows.agreementEvents = [{ month: 6, agreementId: "1" }];

    const res = await request(makeApp()).get("/api/v1/analytics/abc?year=2026").expect(200);

    expect(res.body.year).toBe(2026);
    expect(res.body.data).toHaveLength(12);
    expect(res.body.data.map((d: { month: string }) => d.month)).toEqual([
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sept",
      "Oct",
      "Nov",
      "Dec",
    ]);
    expect(typeof res.body.total).toBe("number");
    // The address is validated and then normalized before it reaches the query
    // layer, so the canonical form is what the DB filters on.
    expect(queryState.eqValues).toContain(normalizeStarknetAddress("abc"));
  });

  it("defaults to the current year when none is supplied", async () => {
    const res = await request(makeApp()).get("/api/v1/analytics/abc").expect(200);
    expect(res.body.year).toBe(new Date().getFullYear());
  });

  it("rejects a malformed address with 400 before any query runs", async () => {
    const res = await request(makeApp()).get("/api/v1/analytics/not-an-address").expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(queryState.eqValues).toHaveLength(0);
  });

  it("computes net payments correctly and ignores agreements when financial activity exists", async () => {
    const address = normalizeStarknetAddress("abc");
    // month 1: received 5, sent 2 (net 3)
    queryState.rows.payments = [
      { month: 1, amount: "5000000", to: address, from: "someone" },
      { month: 1, amount: "2000000", from: address, to: "someone" },
    ];
    // month 2: funded 4 (net -4), released 3 (net +3), refunded 1 (net +1)
    queryState.rows.escrowEvents = [
      { month: 2, amount: "4000000", eventType: "Funded", employer: address, to: "someone" },
      { month: 2, amount: "3000000", eventType: "Released", employer: "someone", to: address },
      { month: 2, amount: "1000000", eventType: "Refunded", employer: address, to: "someone" },
    ];
    // month 3: 2 agreements, but should be ignored because there is financial activity
    queryState.rows.agreementEvents = [
      { month: 3, agreementId: "1" },
      { month: 3, agreementId: "2" },
    ];

    const res = await request(makeApp()).get("/api/v1/analytics/abc").expect(200);
    
    // month 1 should be 3.0
    expect(res.body.data[0].views).toBe(3);
    // month 2 should be -4 + 3 + 1 = 0
    expect(res.body.data[1].views).toBe(0);
    // month 3 should be 0 because agreement fallback is suppressed
    expect(res.body.data[2].views).toBe(0);
    // Total should be 3
    expect(res.body.total).toBe(3);
  });

  it("falls back to agreement counts when there is no financial activity", async () => {
    queryState.rows.payments = [];
    queryState.rows.escrowEvents = [];
    queryState.rows.agreementEvents = [
      { month: 1, agreementId: "1" },
      { month: 1, agreementId: "2" },
      { month: 2, agreementId: "3" },
    ];

    const res = await request(makeApp()).get("/api/v1/analytics/abc").expect(200);
    
    // month 1: 2 agreements * 1000 base units = 0.002
    expect(res.body.data[0].views).toBe(0.002);
    // month 2: 1 agreement * 1000 base units = 0.001
    expect(res.body.data[1].views).toBe(0.001);
    expect(res.body.total).toBe(0.003);
  });

  it("rejects a year below the supported range with 400", async () => {
    await request(makeApp()).get("/api/v1/analytics/abc?year=1999").expect(400);
  });

  it("rejects a year above the supported range with 400", async () => {
    await request(makeApp()).get("/api/v1/analytics/abc?year=3000").expect(400);
  });
});
