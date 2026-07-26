import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  requireAuth,
  requireAdmin,
  readSingleHeader,
  parseBearerToken,
} from "./middleware.js";
import { requireSession } from "./session.js";
import { env } from "../config.js";

// Mock the session module
vi.mock("./session.js", () => ({
  requireSession: vi.fn(),
}));

describe("Auth Middleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      headers: {},
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    mockNext = vi.fn();
  });

  describe("readSingleHeader (helper)", () => {
    it("returns null when the header is missing", () => {
      expect(readSingleHeader(undefined)).toBeNull();
    });

    it("returns null when the header is an array (multi-value)", () => {
      expect(readSingleHeader(["0xa", "0xb"])).toBeNull();
    });

    it("returns null when the header is an empty string", () => {
      expect(readSingleHeader("")).toBeNull();
    });

    it("returns null when the header is whitespace only", () => {
      expect(readSingleHeader("   \t  ")).toBeNull();
    });

    it("returns the trimmed value when the header is a normal string", () => {
      expect(readSingleHeader("  0xabc  ")).toBe("0xabc");
    });
  });

  describe("parseBearerToken (helper)", () => {
    it("returns the token for a well-formed Bearer header", () => {
      expect(parseBearerToken("Bearer abc.def")).toBe("abc.def");
    });

    it("trims surrounding whitespace from the token", () => {
      expect(parseBearerToken("Bearer    abc    ")).toBe("abc");
    });

    it("returns null when the scheme is Basic", () => {
      expect(parseBearerToken("Basic abc")).toBeNull();
    });

    it("returns null when the scheme is lower-case bearer (case-sensitive contract)", () => {
      expect(parseBearerToken("bearer abc")).toBeNull();
    });

    it("returns null when only the prefix is present", () => {
      expect(parseBearerToken("Bearer ")).toBeNull();
    });

    it("returns null when only the prefix with whitespace is present", () => {
      expect(parseBearerToken("Bearer    ")).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(parseBearerToken("")).toBeNull();
    });
  });

  describe("requireAuth", () => {
    it("should return 401 if x-user-address header is missing", async () => {
      mockReq.headers = { authorization: "Bearer valid_token" };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
      expect(requireSession).not.toHaveBeenCalled();
    });

    it("should return 401 if x-user-address is an array of values (single-principal contract)", async () => {
      mockReq.headers = {
        "x-user-address": ["0xone", "0xtwo"],
        authorization: "Bearer valid_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
      expect(requireSession).not.toHaveBeenCalled();
    });

    it("should return 401 if x-user-address is empty or whitespace only", async () => {
      mockReq.headers = {
        "x-user-address": "   ",
        authorization: "Bearer valid_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
      expect(requireSession).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization header is missing", async () => {
      mockReq.headers = { "x-user-address": "0xuser" };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization header is an array of values", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: ["Bearer abc", "Bearer def"],
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
      expect(requireSession).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization header is not Bearer", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Basic some_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization is just the Bearer prefix with no token", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer ",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
      expect(requireSession).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization has lower-case bearer (case-sensitive contract)", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "bearer valid_token",
      };
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if session is invalid", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer invalid_token",
      };
      vi.mocked(requireSession).mockResolvedValue(false);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(requireSession).toHaveBeenCalledWith("0xuser", "invalid_token");
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should still resolve 401 if requireSession itself throws", async () => {
      mockReq.headers = {
        "x-user-address": "0xuser",
        authorization: "Bearer valid_token",
      };
      vi.mocked(requireSession).mockRejectedValue(new Error("db blew up"));

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
      // The throw path must short-circuit before req.auth is attached so a
      // downstream handler can never run with a "valid" principal that was
      // actually an unverified one.
      expect(mockReq.auth).toBeUndefined();
    });

    it("should attach address and token to req.auth and call next if session is valid", async () => {
      mockReq.headers = {
        "x-user-address": "0xUSER", // Test case insensitivity normalization
        authorization: "Bearer valid_token",
      };
      vi.mocked(requireSession).mockResolvedValue(true);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(requireSession).toHaveBeenCalledWith("0xUSER", "valid_token");
      expect(mockReq.auth).toEqual({ address: "0xuser", token: "valid_token" });
      expect(mockNext).toHaveBeenCalled();
    });

    it("should attach req.auth with a single address even when input has extra whitespace", async () => {
      mockReq.headers = {
        "x-user-address": "  0xUser  ",
        authorization: "Bearer   valid_token   ",
      };
      vi.mocked(requireSession).mockResolvedValue(true);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      // readSingleHeader trims both header values at the boundary, so the
      // trimmed forms are what requireSession and req.auth both see.
      expect(requireSession).toHaveBeenCalledWith("0xUser", "valid_token");
      expect(mockReq.auth).toEqual({ address: "0xuser", token: "valid_token" });
      // Single-principal invariant: req.auth is an object, never an array.
      expect(Array.isArray(mockReq.auth)).toBe(false);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("requireAdmin", () => {
    // Save original env
    const originalAdminAddresses = env.ADMIN_ADDRESSES;

    beforeEach(() => {
      env.ADMIN_ADDRESSES = ["0xadmin1", "0xadmin2"];
    });

    afterEach(() => {
      env.ADMIN_ADDRESSES = originalAdminAddresses;
    });

    it("should return 401 if req.auth is missing", () => {
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if req.auth has a non-string address (defensive)", () => {
      // Defensive against prototype pollution or a misconfigured middleware
      // chain that attached req.auth without a string address field.
      mockReq.auth = { address: undefined as unknown as string, token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if req.auth has an empty-string address (defensive)", () => {
      mockReq.auth = { address: "", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 if user is not in admin allowlist", () => {
      mockReq.auth = { address: "0xuser", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: "Unauthorized" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should call next if user is in admin allowlist", () => {
      mockReq.auth = { address: "0xadmin1", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should call next if user is in admin allowlist regardless of casing", () => {
      mockReq.auth = { address: "0xADMIN2", token: "testtoken" };
      requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });
});
