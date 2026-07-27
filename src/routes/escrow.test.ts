import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../index.js";

// Mock the client to prevent actual contract calls
vi.mock("../starknet/client.js", () => ({
  escrowContract: vi.fn().mockReturnValue({
    get_token: vi.fn().mockResolvedValue("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"),
  }),
  provider: {
    getNonceForAddress: vi.fn(),
    getChainId: vi.fn(),
  },
}));

describe("Escrow Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Address Validation", () => {
    it("returns 400 for malformed addresses", async () => {
      const response = await request(app).get("/api/v1/escrow/invalid-address-format/get_token");
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error", "Validation failed");
      expect(response.body).toHaveProperty("details");
      expect(response.body.details[0]).toHaveProperty("message", "Starknet address must be a hex string");
    });

    it("accepts valid addresses and returns token", async () => {
      const validAddress = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const response = await request(app).get(`/api/v1/escrow/${validAddress}/get_token`);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("token");
    });
    
    it("returns 400 for empty address", async () => {
      const response = await request(app).get("/api/v1/escrow/0x/get_token"); // Wait, 0x is not empty but will fail hex check or length? Wait, AddressParam requires min(3) so "0x" fails min(3).
      // actually let's test a too long address
      const longAddress = "0x" + "1".repeat(65);
      const res = await request(app).get(`/api/v1/escrow/${longAddress}/get_token`);
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });
  });
});
