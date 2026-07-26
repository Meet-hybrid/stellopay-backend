import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { readRouter } from "./read.js";
import { provider } from "../starknet/client.js";
import { env } from "../config.js";

// Mock starknet client
const mockEscrow = {
  get_token: vi.fn(),
  get_agreement_balance: vi.fn(),
  get_agreement_employer: vi.fn(),
};

const mockAgreement = {
  get_employer: vi.fn(),
  get_contributor: vi.fn(),
  get_token: vi.fn(),
  get_escrow: vi.fn(),
  get_total_amount: vi.fn(),
  get_paid_amount: vi.fn(),
  get_status: vi.fn(),
  get_agreement_mode: vi.fn(),
  get_dispute_status: vi.fn(),
};

vi.mock("../starknet/client.js", () => ({
  provider: {
    callContract: vi.fn(),
  },
  escrowContract: vi.fn(() => mockEscrow),
  agreementContract: vi.fn(() => mockAgreement),
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", readRouter);
  return app;
}

describe("read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /escrow/:address/summary/:agreement_id", () => {
    it("returns correct summary and formats addresses using unified toHexString", async () => {
      mockEscrow.get_token.mockResolvedValue(12345n); // 0x3039
      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 2000000n, high: 0n });
      mockEscrow.get_agreement_employer.mockResolvedValue("0xabcd");

      const res = await request(makeApp())
        .get("/api/v1/escrow/0x1234/summary/1")
        .expect(200);

      expect(res.body).toEqual({
        escrow: "0x1234",
        agreement_id: "1",
        employer: "0xabcd",
        token: "0x3039",
        balance: "2000000",
      });
    });
  });

  describe("GET /agreement/:address/summary/:agreement_id", () => {
    it("returns correct summary and formats addresses using unified toHexString", async () => {
      mockAgreement.get_employer.mockResolvedValue(100n); // 0x64
      mockAgreement.get_contributor.mockResolvedValue("0x200");
      mockAgreement.get_token.mockResolvedValue(300n); // 0x12c
      mockAgreement.get_escrow.mockResolvedValue(400n); // 0x190
      mockAgreement.get_total_amount.mockResolvedValue({ low: 1000n, high: 0n });
      mockAgreement.get_paid_amount.mockResolvedValue({ low: 500n, high: 0n });
      mockAgreement.get_status.mockResolvedValue(1n);
      mockAgreement.get_agreement_mode.mockResolvedValue(0n);
      mockAgreement.get_dispute_status.mockResolvedValue(2n);

      const res = await request(makeApp())
        .get("/api/v1/agreement/0x5678/summary/2")
        .expect(200);

      expect(res.body).toEqual({
        agreement: "0x5678",
        agreement_id: "2",
        employer: "0x64",
        contributor: "0x200",
        token: "0x12c",
        escrow: "0x190",
        total_amount: "1000",
        paid_amount: "500",
        status: 1,
        mode: 0,
        dispute_status: 2,
      });
    });
  });

  describe("telemetry and error logs", () => {
    let infoSpy: any;
    let errorSpy: any;
    let originalLogFormat: string;

    beforeEach(() => {
      infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      originalLogFormat = env.LOG_FORMAT;
    });

    afterEach(() => {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
      env.LOG_FORMAT = originalLogFormat;
    });

    it("logs structured JSON info on successful token decimals read", async () => {
      env.LOG_FORMAT = "json";
      vi.mocked(provider.callContract).mockResolvedValue(["18"]);

      await request(makeApp())
        .get("/api/v1/token/0x1234/decimals")
        .expect(200);

      expect(infoSpy).toHaveBeenCalled();
      const logs = infoSpy.mock.calls.map((call: any) => JSON.parse(call[0]));
      const tokenLog = logs.find((l: any) => l.operation === "erc20_decimals");
      expect(tokenLog).toBeDefined();
      expect(tokenLog.status).toBe("success");
      expect(tokenLog.token).toBe("0x1234");
      expect(typeof tokenLog.duration_ms).toBe("number");
    });

    it("logs structured JSON error on failed token symbol read", async () => {
      env.LOG_FORMAT = "json";
      vi.mocked(provider.callContract).mockRejectedValue(new Error("RPC Timeout"));

      await request(makeApp())
        .get("/api/v1/token/0x1234/symbol")
        .expect(500);

      expect(errorSpy).toHaveBeenCalled();
      const logs = errorSpy.mock.calls.map((call: any) => JSON.parse(call[0]));
      const tokenLog = logs.find((l: any) => l.operation === "erc20_symbol");
      expect(tokenLog).toBeDefined();
      expect(tokenLog.status).toBe("error");
      expect(tokenLog.error).toBe("RPC Timeout");
    });

    it("logs text format info on successful escrow balance read", async () => {
      env.LOG_FORMAT = "text";
      mockEscrow.get_agreement_balance.mockResolvedValue({ low: 500n, high: 0n });

      await request(makeApp())
        .get("/api/v1/escrow/0x1234/balance/7")
        .expect(200);

      expect(infoSpy).toHaveBeenCalled();
      const logString = infoSpy.mock.calls[0][0];
      expect(logString).toContain("[read-telemetry] escrow_get_agreement_balance success");
      expect(logString).toContain("ms");
    });

    it("logs structured JSON error on failed escrow summary read", async () => {
      env.LOG_FORMAT = "json";
      mockEscrow.get_token.mockRejectedValue(new Error("Escrow contract offline"));

      await request(makeApp())
        .get("/api/v1/escrow/0x1234/summary/1")
        .expect(500);

      expect(errorSpy).toHaveBeenCalled();
      const logs = errorSpy.mock.calls.map((call: any) => JSON.parse(call[0]));
      const escrowLog = logs.find((l: any) => l.operation === "escrow_get_summary");
      expect(escrowLog).toBeDefined();
      expect(escrowLog.status).toBe("error");
      expect(escrowLog.error).toBe("Escrow contract offline");
    });

    it("logs structured JSON info on successful agreement summary read", async () => {
      env.LOG_FORMAT = "json";
      mockAgreement.get_employer.mockResolvedValue(100n);
      mockAgreement.get_contributor.mockResolvedValue("0x200");
      mockAgreement.get_token.mockResolvedValue(300n);
      mockAgreement.get_escrow.mockResolvedValue(400n);
      mockAgreement.get_total_amount.mockResolvedValue({ low: 1000n, high: 0n });
      mockAgreement.get_paid_amount.mockResolvedValue({ low: 500n, high: 0n });
      mockAgreement.get_status.mockResolvedValue(1n);
      mockAgreement.get_agreement_mode.mockResolvedValue(0n);
      mockAgreement.get_dispute_status.mockResolvedValue(2n);

      await request(makeApp())
        .get("/api/v1/agreement/0x5678/summary/2")
        .expect(200);

      expect(infoSpy).toHaveBeenCalled();
      const logs = infoSpy.mock.calls.map((call: any) => JSON.parse(call[0]));
      const agreementLog = logs.find((l: any) => l.operation === "agreement_get_summary");
      expect(agreementLog).toBeDefined();
      expect(agreementLog.status).toBe("success");
      expect(agreementLog.agreement).toBe("0x5678");
      expect(agreementLog.agreement_id).toBe("2");
    });
  });
});
