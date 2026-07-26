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

import { backfillEventsRouter } from "./backfill-events.js";

/** Reset DB mocks to a default working state. */
function setupDbDefaults() {
  mockDb.execute.mockResolvedValue({ rows: [] });
  mockTransaction.mockImplementation(async (cb: any) => cb(mockDb));
}

describe("Backfill Events Routes (Hardened with Observability)", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {}); // Spy on logs
    setupDbDefaults();

    app = express();
    app.use(express.json());
    app.use("/api/v1", backfillEventsRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status || 500).json({ error: err.message });
    });
  });

  describe("Input Validation & Resume Tokens", () => {
    it("rejects a malformed resumeToken (not an ISO date)", async () => {
      const res = await request(app)
        .post("/api/v1/backfill/employee-events?resumeToken=invalid-date")
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it("accepts a valid resumeToken and passes it to the query", async () => {
      const validToken = "2026-07-25T10:00:00.000Z";
      await request(app)
        .post(`/api/v1/backfill/employee-events?resumeToken=${validToken}`)
        .expect(200);

      // Verify the DB execute was called (SQL check happens in integration, here we verify call)
      expect(mockDb.execute).toHaveBeenCalled();
    });
  });

  describe("POST /backfill/employee-events (Metrics & Logs)", () => {
    const mockDate = new Date("2024-01-01T12:00:00Z");
    const mockEmployeeRow = {
      id: "emp_1",
      agreement_id: "agr_123",
      contract_address: "0xabc",
      block_number: 100,
      transaction_hash: "0xtx1",
      created_at: mockDate.toISOString(),
    };

    it("returns nextResumeToken and durationMs on success", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      // Check for Replay Window support
      expect(res.body.nextResumeToken).toBe(mockEmployeeRow.created_at);
      
      // Check for Telemetry/Metrics
      expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof res.body.durationMs).toBe("number");
    });

    it("emits a structured log on completion", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockEmployeeRow] });

      await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(console.info).toHaveBeenCalledWith(
        expect.objectContaining({
          op: "backfill_employee_events",
          scanned: 1,
          created: 1,
          durationMs: expect.any(Number),
          nextResumeToken: mockEmployeeRow.created_at
        })
      );
    });

    it("returns null for nextResumeToken if no rows were scanned", async () => {
      mockDb.execute.mockResolvedValue({ rows: [] });

      const res = await request(app)
        .post("/api/v1/backfill/employee-events")
        .expect(200);

      expect(res.body.nextResumeToken).toBeNull();
    });
  });

  describe("POST /backfill/milestone-events (Metrics & Logs)", () => {
    const mockMilestoneRow = {
      id: "ms_1",
      agreement_id: "agr_456",
      contract_address: "0xdef",
      block_number: 200,
      transaction_hash: "0xtx2",
      created_at: "2024-02-01T10:00:00Z",
    };

    it("emits structured logs for milestones", async () => {
      mockDb.execute.mockResolvedValue({ rows: [mockMilestoneRow] });

      const res = await request(app)
        .post("/api/v1/backfill/milestone-events")
        .expect(200);

      expect(res.body.nextResumeToken).toBe(mockMilestoneRow.created_at);
      expect(console.info).toHaveBeenCalledWith(
        expect.objectContaining({
          op: "backfill_milestone_events",
          durationMs: expect.any(Number)
        })
      );
    });
  });
});
