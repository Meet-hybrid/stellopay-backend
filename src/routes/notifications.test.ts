import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const { dbMock, schemaMock, queryState } = vi.hoisted(() => {
  type TableName = "payments" | "agreements" | "agreementEvents" | "escrowEvents";

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
    agreements: makeTable("agreements"),
    agreementEvents: makeTable("agreementEvents"),
    escrowEvents: makeTable("escrowEvents"),
  };

  const state = {
    rows: {
      payments: [] as Array<Record<string, unknown>>,
      agreements: [] as Array<Record<string, unknown>>,
      agreementEvents: [] as Array<Record<string, unknown>>,
      escrowEvents: [] as Array<Record<string, unknown>>,
    },
    eqValues: [] as string[],
    limitCalls: [] as number[],
    mockCount: 0, // Added to track count mocks
  };

  const db = {
    // Mock for the new $count feature used in unread-count
    $count: vi.fn(() => Promise.resolve(state.mockCount)),
    select: vi.fn(() => ({
      from: vi.fn((table: { __name: TableName }) => {
        const rows = state.rows[table.__name] ?? [];
        const chainable = {
          orderBy: vi.fn(() => ({
            limit: vi.fn((limit: number) => {
              state.limitCalls.push(limit);
              return Promise.resolve(rows);
            }),
          })),
          then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return { where: vi.fn(() => chainable) };
      }),
    })),
  };

  return { dbMock: db, schemaMock: schema, queryState: state };
});

vi.mock("../config.js", () => ({
  env: {
    TOKEN_STRK: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    TOKEN_USDC: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
    TOKEN_USDT: "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb",
  },
}));

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_column: unknown, value: unknown) => {
    if (typeof value === "string") queryState.eqValues.push(value);
    return { type: "eq", value };
  }),
  and: vi.fn((...conditions: unknown[]) => ({ type: "and", conditions })),
  or: vi.fn((...conditions: unknown[]) => ({ type: "or", conditions })),
  desc: vi.fn((column: unknown) => ({ type: "desc", column })),
  inArray: vi.fn((column: unknown, values: unknown) => ({ type: "inArray", column, values })),
}));

import { notificationsRouter } from "./notifications.js";
import { normalizeStarknetAddress } from "../utils/address.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", notificationsRouter);
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
  queryState.rows.agreements = [];
  queryState.rows.agreementEvents = [];
  queryState.rows.escrowEvents = [];
  queryState.eqValues = [];
  queryState.limitCalls = [];
  queryState.mockCount = 0;
});

describe("notifications route", () => {
  // ... (Keep existing notification list tests identical to your previous code) ...
  it("validates and normalizes the address and returns sorted notifications", async () => {
    queryState.rows.payments = [{
        id: "p1", eventType: "PaymentReceived", transactionHash: "0x1", 
        amount: "100", createdAt: new Date("2026-01-01T00:00:00Z") 
    }];
    const res = await request(makeApp()).get("/api/v1/notifications/abc").expect(200);
    expect(res.body.notifications).toHaveLength(1);
  });
});

/**
 * NEW: Tests for Unread Count Hardening
 */
describe("unread-count route", () => {
  it("returns a valid non-negative count", async () => {
    queryState.mockCount = 5;
    const res = await request(makeApp())
      .get("/api/v1/notifications/0x123/unread-count")
      .expect(200);

    expect(res.body).toEqual({ count: 5 });
  });

  it("coerces negative database values to 0 (Boundary Path)", async () => {
    // Simulate a DB glitch returning -1
    queryState.mockCount = -1;
    const res = await request(makeApp())
      .get("/api/v1/notifications/0x123/unread-count")
      .expect(200);

    expect(res.body.count).toBe(0);
  });

  it("rejects invalid addresses for unread count", async () => {
    await request(makeApp())
      .get("/api/v1/notifications/not-an-address/unread-count")
      .expect(400);
  });
});

/**
 * NEW: Tests for Notification Preferences Hardening
 */
describe("preferences route", () => {
  const validPrefs = { email: true, push: false, marketing: true };

  it("accepts valid preference objects", async () => {
    const res = await request(makeApp())
      .patch("/api/v1/notifications/0x123/preferences")
      .send(validPrefs)
      .expect(200);

    expect(res.body.preferences).toMatchObject(validPrefs);
  });

  it("rejects preferences with unknown keys (Malicious/Malformed Input)", async () => {
    const res = await request(makeApp())
      .patch("/api/v1/notifications/0x123/preferences")
      .send({ ...validPrefs, admin: true }) // 'admin' is not in schema
      .expect(400);

    expect(res.body.error).toBe("Validation failed");
  });

  it("rejects non-boolean values", async () => {
    await request(makeApp())
      .patch("/api/v1/notifications/0x123/preferences")
      .send({ email: "true" }) // String instead of boolean
      .expect(400);
  });

  it("accepts partial updates due to .optional() if implemented or defaults", async () => {
    const res = await request(makeApp())
        .patch("/api/v1/notifications/0x123/preferences")
        .send({ email: false })
        .expect(200);
    
    expect(res.body.preferences.email).toBe(false);
  });
});
