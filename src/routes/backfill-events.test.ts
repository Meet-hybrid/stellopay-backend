import { vi, describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const { mockRequireAuth, mockRequireAdmin } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  mockRequireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock("../auth/middleware.js", () => ({
  requireAuth: mockRequireAuth,
  requireAdmin: mockRequireAdmin,
}));

const { mockDb, mockInsertReturning, mockTransaction } = vi.hoisted(() => {
  const onConflictDoNothing = vi.fn().mockResolvedValue({});
  const insertReturning = { values: vi.fn().mockReturnThis(), onConflictDoNothing };
  const insert = vi.fn().mockReturnValue(insertReturning);
  const transaction = vi.fn();
  const execute = vi.fn();
  return {
    mockDb: {
      insert,
      execute,
      transaction,
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    },
    mockInsertReturning: insertReturning,
    mockTransaction: transaction,
  };
});

vi.mock("../db/index.js", () => ({
  db: mockDb,
  schema: {
    agreementEvents: { id: "agreementEvents" },
  },
}));

import {
  backfillEventsRouter,
  MAX_BACKFILL_LIMIT,
  DEFAULT_BACKFILL_LIMIT,
  BACKFILL_EVENT_INDEX,
  RESULTS_PREVIEW_SIZE,
  buildBackfillEventId,
  BackfillQuerySchema,
} from "./backfill-events.js";

/** Reset DB mocks to a default working state. */
function setupDbDefaults() {
  mockDb.execute.mockResolvedValue({ rows: [] });
  mockTransaction.mockImplementation(async (cb: any) => cb(mockDb));
}

// ---------------------------------------------------------------------------
// Unit tests for the exported contract surface
// ---------------------------------------------------------------------------

describe("Backfill contract constants", () => {
  it("MAX_BACKFILL_LIMIT is 5000", () => {
    expect(MAX_BACKFILL_LIMIT).toBe(5000);
  });

  it("DEFAULT_BACKFILL_LIMIT is 1000", () => {
    expect(DEFAULT_BACKFILL_LIMIT).toBe(1000);
  });

  it("BACKFILL_EVENT_INDEX is -1 (impossible for real events)", () => {
    expect(BACKFILL_EVENT_INDEX).toBe(-1);
  });

  it("RESULTS_PREVIEW_SIZE is 10", () => {
    expect(RESULTS_PREVIEW_SIZE).toBe(10);
  });
});

describe("buildBackfillEventId", () => {
  it("builds the expected {txHash}_backfill_{eventType}_{rowId} format", () => {
    expect(buildBackfillEventId("0xabc", "EmployeeAdded", "emp_1")).toBe(
      "0xabc_backfill_EmployeeAdded_emp_1",
    );
  });

  it("includes the _backfill_ segment that cannot collide with real IDs", () => {
    const id = buildBackfillEventId("0x123", "MilestoneAdded", "ms_7");
    expect(id).toContain("_backfill_");
    expect(id).toBe("0x123_backfill_MilestoneAdded_ms_7");
  });

  it("handles empty strings without throwing", () => {
    expect(buildBackfillEventId("", "", "")).toBe("_backfill__");
  });
});

describe("BackfillQuerySchema", () => {
  it("defaults limit to DEFAULT_BACKFILL_LIMIT when omitted", () => {
    const result = BackfillQuerySchema.parse({});
    expect(result.limit).toBe(DEFAULT_BACKFILL_LIMIT);
  });

  it("accepts limit at the lower boundary (1)", () => {
    const result = BackfillQuerySchema.parse({ limit: "1" });
    expect(result.limit).toBe(1);
  });

  it("accepts limit at the upper boundary (MAX_BACKFILL_LIMIT)", () => {
    const result = BackfillQuerySchema.parse({ limit: String(MAX_BACKFILL_LIMIT) });
    expect(result.limit).toBe(MAX_BACKFILL_LIMIT);
  });

  it("rejects limit above MAX_BACKFILL_LIMIT", () => {
    expect(() => BackfillQuerySchema.parse({ limit: String(MAX_BACKFILL_LIMIT + 1) })).toThrow();
  });

  it("rejects zero", () => {
    expect(() => BackfillQuerySchema.parse({ limit: "0" })).toThrow();
  });

  it("rejects negative values", () => {
    expect(() => BackfillQuerySchema.parse({ limit: "-5" })).toThrow();
  });

  it("rejects non-numeric strings", () => {
    expect(() => BackfillQuerySchema.parse({ limit: "abc" })).toThrow();
  });

  it("rejects floating-point values", () => {
    expect(() => BackfillQuerySchema.parse({ limit: "10.5" })).toThrow();
  });

  it("passes agreementId through unchanged", () => {
    const result = BackfillQuerySchema.parse({ agreementId: "agr_123" });
    expect(result.agreementId).toBe("agr_123");
  });

  it("leaves agreementId undefined when not provided", () => {
    const result = BackfillQuerySchema.parse({});
    expect(result.agreementId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Route-level integration tests
// ---------------------------------------------------------------------------

describe("Backfill Events Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDbDefaults();

    app = express();
    app.use(express.json());
    app.use("/api/v1", backfillEventsRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status || 500).json({ error: err.message });
    });
  });

  describe("Authentication & Authorization", () => {
    it("rejects unauthenticated requests (requireAuth fails)", async () => {
      mockRequireAuth.mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(401);

      expect(res.body).toEqual({ error: "Unauthorized" });
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("rejects non-admin requests (requireAdmin fails)", async () => {
      mockRequireAdmin.mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(401);

      expect(res.body).toEqual({ error: "Unauthorized" });
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests for milestone backfill", async () => {
      mockRequireAuth.mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(401);

      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("rejects non-admin requests for milestone backfill", async () => {
      mockRequireAdmin.mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(401);

      expect(res.body).toEqual({ error: "Unauthorized" });
    });
  });

  describe("Input Validation", () => {
    it("rejects negative limit (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=-1")
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("rejects zero limit (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=0")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("rejects limit exceeding MAX_BACKFILL_LIMIT (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=5001")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("rejects non-integer limit (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=abc")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("rejects floating-point limit (400)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=10.5")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("accepts valid limit and agreementId", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=100&agreementId=agr_123")
        .expect(200);

      expect(res.body.created).toBe(0);
    });

    it("defaults limit to 1000 when not provided", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.totalScanned).toBe(0);
    });

    it("accepts limit at the exact MAX_BACKFILL_LIMIT boundary (5000)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=5000")
        .expect(200);

      expect(res.body.totalScanned).toBe(0);
    });

    it("accepts limit=1 (lower boundary)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?limit=1")
        .expect(200);

      expect(res.body.totalScanned).toBe(0);
    });

    it("rejects milestone-events with invalid limit too", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/milestone-events?limit=-1")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });
  });

  describe("POST /backfill/employee-events", () => {
    const mockEmployeeRow = {
      id: "emp_1",
      agreement_id: "agr_123",
      contract_address: "0xabc",
      block_number: 100,
      transaction_hash: "0xtx1",
      created_at: new Date("2024-01-01"),
    };

    it("backfills EmployeeAdded events successfully", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.message).toContain("Backfilled 1 EmployeeAdded events");
      expect(res.body.created).toBe(1);
      expect(res.body.totalScanned).toBe(1);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0]).toEqual({
        employeeId: "emp_1",
        agreementId: "agr_123",
        status: "created",
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it("is idempotent on re-run (no new employees without events)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
    });

    it("uses collision-safe event ID scheme and eventIndex -1", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(insertedValues).not.toBeNull();
      expect(insertedValues.id).toBe("0xtx1_backfill_EmployeeAdded_emp_1");
      expect(insertedValues.eventIndex).toBe(-1);
      expect(insertedValues.eventType).toBe("EmployeeAdded");
    });

    it("event ID matches buildBackfillEventId output", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      const expectedId = buildBackfillEventId("0xtx1", "EmployeeAdded", "emp_1");
      expect(insertedValues.id).toBe(expectedId);
    });

    it("eventIndex matches BACKFILL_EVENT_INDEX constant", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(insertedValues.eventIndex).toBe(BACKFILL_EVENT_INDEX);
    });

    it("runs inserts inside a transaction", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(mockTransaction).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("uses onConflictDoNothing for idempotent inserts", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(mockInsertReturning.onConflictDoNothing).toHaveBeenCalled();
    });

    it("filters by agreementId when query param is provided", async () => {
      await request(app)
        .post("/api/v1/backfill/employee-events?agreementId=agr_123")
        .expect(200);

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("handles empty results gracefully", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
      expect(res.body.results).toEqual([]);
    });

    it("handles outer catch-all error", async () => {
      mockDb.execute.mockRejectedValue(new Error("DB Connection Failed"));

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(500);

      expect(res.body.error).toBe("DB Connection Failed");
    });

    it("limits results array to 10 entries", async () => {
      const manyRows = Array.from({ length: 20 }, (_, i) => ({
        id: `emp_${i}`,
        agreement_id: `agr_${i}`,
        contract_address: "0xabc",
        block_number: 100 + i,
        transaction_hash: `0xtx${i}`,
        created_at: new Date("2024-01-01"),
      }));
      mockDb.execute.mockResolvedValue({ rows: manyRows });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.results).toHaveLength(10);
      expect(res.body.created).toBe(20);
    });

    it("results preview size matches RESULTS_PREVIEW_SIZE constant", async () => {
      const manyRows = Array.from({ length: RESULTS_PREVIEW_SIZE + 5 }, (_, i) => ({
        id: `emp_${i}`,
        agreement_id: `agr_${i}`,
        contract_address: "0xabc",
        block_number: 100 + i,
        transaction_hash: `0xtx${i}`,
        created_at: new Date("2024-01-01"),
      }));
      mockDb.execute.mockResolvedValue({ rows: manyRows });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.results).toHaveLength(RESULTS_PREVIEW_SIZE);
      expect(res.body.created).toBe(RESULTS_PREVIEW_SIZE + 5);
    });

    it("propagates transaction errors to the error handler (500)", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });
      mockTransaction.mockRejectedValue(new Error("Transaction failed"));

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(500);

      expect(res.body.error).toBe("Transaction failed");
    });

    it("handles multiple employees in one batch", async () => {
      const threeRows = [
        { ...mockEmployeeRow, id: "emp_1", transaction_hash: "0xtx1" },
        { ...mockEmployeeRow, id: "emp_2", transaction_hash: "0xtx2" },
        { ...mockEmployeeRow, id: "emp_3", transaction_hash: "0xtx3" },
      ];
      mockDb.execute.mockResolvedValue({ rows: threeRows });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.created).toBe(3);
      expect(res.body.totalScanned).toBe(3);
      expect(res.body.results).toHaveLength(3);
    });

    it("response has the documented BackfillResponse shape", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      // Verify all documented top-level keys exist
      expect(res.body).toHaveProperty("message");
      expect(res.body).toHaveProperty("totalScanned");
      expect(res.body).toHaveProperty("created");
      expect(res.body).toHaveProperty("results");
      expect(typeof res.body.message).toBe("string");
      expect(typeof res.body.totalScanned).toBe("number");
      expect(typeof res.body.created).toBe("number");
      expect(Array.isArray(res.body.results)).toBe(true);
    });
  });

  describe("POST /backfill/milestone-events", () => {
    const mockMilestoneRow = {
      id: "ms_1",
      agreement_id: "agr_456",
      contract_address: "0xdef",
      block_number: 200,
      transaction_hash: "0xtx2",
      created_at: new Date("2024-02-01"),
    };

    it("backfills MilestoneAdded events successfully", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.message).toContain("Backfilled 1 MilestoneAdded events");
      expect(res.body.created).toBe(1);
      expect(res.body.totalScanned).toBe(1);
    });

    it("is idempotent on re-run", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.created).toBe(0);
    });

    it("uses collision-safe event IDs", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(insertedValues!.id).toBe("0xtx2_backfill_MilestoneAdded_ms_1");
      expect(insertedValues!.eventIndex).toBe(-1);
      expect(insertedValues!.eventType).toBe("MilestoneAdded");
    });

    it("event ID matches buildBackfillEventId output", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      const expectedId = buildBackfillEventId("0xtx2", "MilestoneAdded", "ms_1");
      expect(insertedValues!.id).toBe(expectedId);
    });

    it("eventIndex matches BACKFILL_EVENT_INDEX constant", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      let insertedValues: any = null;
      mockInsertReturning.values.mockImplementation((values: any) => {
        insertedValues = values;
        return mockInsertReturning;
      });

      await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(insertedValues!.eventIndex).toBe(BACKFILL_EVENT_INDEX);
    });

    it("runs inserts inside a transaction", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(mockTransaction).toHaveBeenCalled();
    });

    it("uses onConflictDoNothing for idempotent inserts", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(mockInsertReturning.onConflictDoNothing).toHaveBeenCalled();
    });

    it("handles empty results gracefully", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.created).toBe(0);
      expect(res.body.totalScanned).toBe(0);
    });

    it("handles outer catch-all error", async () => {
      mockDb.execute.mockRejectedValue(new Error("DB Connection Failed"));

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(500);

      expect(res.body.error).toBe("DB Connection Failed");
    });

    it("limits results array to RESULTS_PREVIEW_SIZE entries", async () => {
      const manyRows = Array.from({ length: 20 }, (_, i) => ({
        id: `ms_${i}`,
        agreement_id: `agr_${i}`,
        contract_address: "0xdef",
        block_number: 200 + i,
        transaction_hash: `0xtx${i}`,
        created_at: new Date("2024-02-01"),
      }));
      mockDb.execute.mockResolvedValue({ rows: manyRows });

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.results).toHaveLength(RESULTS_PREVIEW_SIZE);
      expect(res.body.created).toBe(20);
    });

    it("propagates transaction errors to the error handler (500)", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });
      mockTransaction.mockRejectedValue(new Error("Transaction failed"));

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(500);

      expect(res.body.error).toBe("Transaction failed");
    });

    it("response has the documented BackfillResponse shape", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body).toHaveProperty("message");
      expect(res.body).toHaveProperty("totalScanned");
      expect(res.body).toHaveProperty("created");
      expect(res.body).toHaveProperty("results");
      expect(typeof res.body.message).toBe("string");
      expect(typeof res.body.totalScanned).toBe("number");
      expect(typeof res.body.created).toBe("number");
      expect(Array.isArray(res.body.results)).toBe(true);
    });
  });
});
