import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ZodError } from "zod";

// Mock the db module and drizzle-orm
const { dbMock, schemaMock, state, limitSpy, offsetSpy } = vi.hoisted(() => {
  const limitSpy = vi.fn();
  const offsetSpy = vi.fn();
  const state = { rows: {} as Record<string, any[]> };

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
        // Track which table was limited and by how much
        limitSpy(tableName, n);
        return chain;
      },
      offset: (n: number) => {
        offsetSpy(tableName, n);
        return chain;
      },
      then: (resolve: (rows: any[]) => unknown) =>
        resolve(joined ? [] : (state.rows[tableName] ?? [])),
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
          { get: (_tt, p: string) => (p === "__name" ? name : "col") }
        ),
    }
  );
  return { dbMock: db, schemaMock: schema, state, limitSpy, offsetSpy };
});

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("drizzle-orm", () => ({
  eq: () => "eq",
  and: () => "and",
  or: () => "or",
  desc: () => "desc",
}));

import { indexedRouter } from "./indexed";

const VALID = `0x${"a".repeat(63)}1`;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", indexedRouter);
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const isZod = err instanceof ZodError;
      res.status(isZod ? 400 : (err?.status ?? 500)).json({
        error: isZod ? "Validation failed" : err?.message,
        details: err?.issues ?? undefined,
      });
    }
  );
  return app;
}

beforeEach(() => {
  limitSpy.mockClear();
  offsetSpy.mockClear();
  state.rows = {};
});

describe("indexed routes validation", () => {
  it("rejects a malformed user address with 400", async () => {
    const res = await request(makeApp()).get("/api/v1/indexed/payments/user/not-an-address");
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric agreement_id with 400", async () => {
    const res = await request(makeApp()).get(`/api/v1/indexed/agreement/${VALID}/12ab`);
    expect(res.status).toBe(400);
  });
});

describe("indexed routes pagination and bounding", () => {
  it("clamps an oversized limit to 100 on the payments list", async () => {
    await request(makeApp()).get(`/api/v1/indexed/payments/user/${VALID}?limit=5000`);
    expect(limitSpy).toHaveBeenCalledWith("payments", 100);
  });

  it("bounds sub-resource queries in agreement detail view to 200 (Hardening)", async () => {
    state.rows.agreements = [{ id: "7", contractAddress: VALID }];
    
    await request(makeApp()).get(`/api/v1/indexed/agreement/${VALID}/7`);

    // Verify that sub-queries for detail view are bounded
    expect(limitSpy).toHaveBeenCalledWith("agreementEvents", 200);
    expect(limitSpy).toHaveBeenCalledWith("payments", 200);
    expect(limitSpy).toHaveBeenCalledWith("milestones", 200);
    expect(limitSpy).toHaveBeenCalledWith("escrowEvents", 200);
  });
});

describe("indexed routes data paths", () => {
  it("deduplicates agreements by id for a user", async () => {
    state.rows.agreements = [
      { id: "a1", contractAddress: VALID, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() },
      { id: "a1", contractAddress: VALID, employer: VALID, contributor: VALID, mode: 0, createdAt: new Date() },
    ];
    const res = await request(makeApp()).get(`/api/v1/indexed/agreements/${VALID}/user/${VALID}`);
    expect(res.body.count).toBe(1);
  });

  it("returns 404 when an agreement is not found", async () => {
    state.rows.agreements = [];
    const res = await request(makeApp()).get(`/api/v1/indexed/agreement/${VALID}/99`);
    expect(res.status).toBe(404);
  });

  it("computes escrow balance correctly", async () => {
    state.rows.escrowEvents = [
      { eventType: "Funded", amount: "1000" },
      { eventType: "Released", amount: "400" },
    ];
    const res = await request(makeApp()).get(`/api/v1/indexed/escrow/${VALID}/balance/7`);
    expect(res.body.balance).toBe("600");
  });
});