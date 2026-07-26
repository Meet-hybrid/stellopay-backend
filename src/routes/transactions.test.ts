import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { transactionsRouter } from "./transactions.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock starknet client
vi.mock("../starknet/client.js", () => ({
  agreementContract: vi.fn(() => ({
    get_token: vi.fn().mockResolvedValue(12345n),
  })),
}));

// Mock config with valid hex token addresses so the router can normalize them.
vi.mock("../config.js", () => ({
  env: {
    LOG_LEVEL: "info",
    TOKEN_STRK:
      "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    TOKEN_USDC:
      "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
    TOKEN_USDT:
      "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb",
  },
}));

// ---------------------------------------------------------------------------
// Auth middleware mock — default behaviour: authenticated as the owner address.
// Individual test suites can override req.auth to simulate different callers.
// ---------------------------------------------------------------------------
const OWNER_ADDRESS =
  "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";
const OTHER_ADDRESS =
  "0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * Controls what requireAuth injects into req.auth for the current test.
 * Set to `null` to simulate an unauthenticated (no-session) request.
 */
let mockAuthResult: { address: string; token: string } | null = {
  address: OWNER_ADDRESS,
  token: "test-token",
};

vi.mock("../auth/middleware.js", () => ({
  requireAuth: vi.fn(async (req: any, res: any, next: any) => {
    if (!mockAuthResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.auth = mockAuthResult;
    next();
  }),
}));

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

const createQueryChain = (results: any[]) => {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.offset = vi.fn(() => chain);
  // Make the chain thenable so await works
  chain.then = (resolve: any) => resolve(results);
  return chain;
};

vi.mock("../db/index.js", () => {
  return {
    db: {
      select: vi.fn((arg) => {
        // Simple heuristic: if arg has 'count', it's a count query
        if (arg && arg.count) {
          return createQueryChain([{ count: 2 }]);
        }
        // Otherwise it's a data query
        return createQueryChain([
          {
            id: "1",
            agreementId: "1",
            contractAddress:
              "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
            eventType: "PaymentSent",
            blockNumber: 100,
            transactionHash:
              "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            createdAt: new Date(),
            from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
            to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
            amount: "1000000",
            token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
          },
        ]);
      }),
    },
    schema: {
      payments: {
        from: "from",
        to: "to",
        eventType: "eventType",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        id: "id",
      },
      escrowEvents: {
        employer: "employer",
        to: "to",
        eventType: "eventType",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        id: "id",
      },
      agreements: {
        employer: "employer",
        contributor: "contributor",
        token: "token",
        id: "id",
        contractAddress: "contractAddress",
      },
      agreementEvents: {
        eventType: "eventType",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        agreementId: "agreementId",
        contractAddress: "contractAddress",
        transactionHash: "transactionHash",
        id: "id",
      },
      employees: {
        employeeAddress: "employeeAddress",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        agreementId: "agreementId",
        contractAddress: "contractAddress",
        transactionHash: "transactionHash",
        salaryPerPeriod: "salaryPerPeriod",
        id: "id",
      },
      milestones: {
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        agreementId: "agreementId",
        contractAddress: "contractAddress",
        transactionHash: "transactionHash",
        amount: "amount",
        id: "id",
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Express app under test
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(transactionsRouter);
app.use((err: any, req: any, res: any, next: any) => {
  res.status(500).json({ error: err.message });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
const ownerUrl = `/transactions/${OWNER_ADDRESS}`;
const otherUrl = `/transactions/${OTHER_ADDRESS}`;

// ===========================================================================
// Authorization — unauthenticated access (no session)
// ===========================================================================
describe("Transactions Router — unauthenticated requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult = null; // simulate missing / expired session
  });

  it("GET /transactions/:user_address returns 401 without a session", async () => {
    const res = await request(app).get(ownerUrl);
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("GET /transactions/:user_address/filtered returns 401 without a session", async () => {
    const res = await request(app).get(`${ownerUrl}/filtered`);
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });
});

// ===========================================================================
// Authorization — cross-user access (authenticated but wrong address)
// ===========================================================================
describe("Transactions Router — cross-user access prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Authenticated as OWNER but requesting OTHER's data
    mockAuthResult = { address: OWNER_ADDRESS, token: "test-token" };
  });

  it("GET /transactions/:user_address returns 403 when address does not match session", async () => {
    const res = await request(app).get(otherUrl);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("GET /transactions/:user_address/filtered returns 403 when address does not match session", async () => {
    const res = await request(app).get(`${otherUrl}/filtered`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("owner can access their own transactions", async () => {
    const res = await request(app).get(ownerUrl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);
  });
});

// ===========================================================================
// eventTypes allowlist validation
// ===========================================================================
describe("Transactions Router — eventTypes allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult = { address: OWNER_ADDRESS, token: "test-token" };
  });

  it("returns 400 for an unrecognised event type", async () => {
    const res = await request(app).get(
      `${ownerUrl}?eventTypes=UNKNOWN_EVIL_TYPE`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown event type/);
  });

  it("returns 400 when at least one event type in the list is unknown", async () => {
    const res = await request(app).get(
      `${ownerUrl}?eventTypes=PaymentSent,INJECT`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("INJECT");
  });

  it("returns 200 for a valid single event type", async () => {
    const res = await request(app).get(`${ownerUrl}?eventTypes=PaymentSent`);
    expect(res.status).toBe(200);
  });

  it("returns 200 for multiple valid event types", async () => {
    const res = await request(app).get(
      `${ownerUrl}?eventTypes=PaymentSent,PaymentReceived,Funded`,
    );
    expect(res.status).toBe(200);
  });

  it("returns 200 when eventTypes is omitted (no filter)", async () => {
    const res = await request(app).get(ownerUrl);
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Date validation — filtered endpoint
// ===========================================================================
describe("Transactions Router — date validation on /filtered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult = { address: OWNER_ADDRESS, token: "test-token" };
  });

  it("returns 400 for an invalid startDate", async () => {
    const res = await request(app).get(
      `${ownerUrl}/filtered?startDate=not-a-date`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid startDate/);
  });

  it("returns 400 for an invalid endDate", async () => {
    const res = await request(app).get(
      `${ownerUrl}/filtered?endDate=garbage`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid endDate/);
  });

  it("returns 400 when startDate is after endDate", async () => {
    const res = await request(app).get(
      `${ownerUrl}/filtered?startDate=2025-12-31&endDate=2025-01-01`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/startDate must not be after endDate/);
  });

  it("returns 200 for a valid date range", async () => {
    const res = await request(app).get(
      `${ownerUrl}/filtered?startDate=2025-01-01&endDate=2025-12-31`,
    );
    expect(res.status).toBe(200);
  });

  it("returns 200 when no date filters are supplied", async () => {
    const res = await request(app).get(`${ownerUrl}/filtered`);
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Pagination (existing success paths — preserved from original test suite)
// ===========================================================================
describe("Transactions Router — pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult = { address: OWNER_ADDRESS, token: "test-token" };
  });

  it("should return correct total and clamp limit", async () => {
    const res = await request(app).get(`${ownerUrl}?limit=200`);

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.total).toBe(10);
    expect(res.body.transactions.length).toBe(5);
    expect(res.body.hasMore).toBe(false);
  });

  it("should calculate hasMore correctly when paginating", async () => {
    const res = await request(app).get(`${ownerUrl}?limit=5`);

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.hasMore).toBe(true);
  });

  it("should work for filtered endpoint with similar logic", async () => {
    const res = await request(app).get(`${ownerUrl}/filtered?limit=5`);

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(10);
    expect(res.body.hasMore).toBe(true);
  });

  it("should handle empty results smoothly", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 0 }]);
      return createQueryChain([]);
    });

    const res = await request(app).get(ownerUrl);

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.transactions.length).toBe(0);
    expect(res.body.hasMore).toBe(false);
  });
});

// ===========================================================================
// Logging (existing behaviour — preserved from original test suite)
// ===========================================================================
describe("Transactions Router — logging", () => {
  const userAddress = OWNER_ADDRESS;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuthResult = { address: userAddress, token: "test-token" };

    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 1 }]);
      return createQueryChain([
        {
          id: "1",
          agreementId: "1",
          contractAddress: userAddress,
          eventType: "PaymentReceived",
          blockNumber: 100,
          transactionHash:
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          createdAt: new Date(),
          from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
          amount: "1500000",
          token: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
        },
      ]);
    });

    const { env } = await import("../config.js");
    (env as { LOG_LEVEL?: string }).LOG_LEVEL = "info";

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("stays silent and still returns transactions at the default log level", async () => {
    const res = await request(app).get(`/transactions/${userAddress}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("emits diagnostics through console.debug only when LOG_LEVEL is debug", async () => {
    const { env } = await import("../config.js");
    (env as { LOG_LEVEL?: string }).LOG_LEVEL = "debug";

    const res = await request(app).get(`/transactions/${userAddress}`);

    expect(res.status).toBe(200);
    expect(debugSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
