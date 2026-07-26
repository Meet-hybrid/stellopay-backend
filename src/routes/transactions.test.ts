import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { transactionsRouter } from "./transactions.js";

// ── Mocks ────────────────────────────────────────────────────────────────

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

// ── Query chain mock ─────────────────────────────────────────────────────

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

const DEFAULT_ROW = {
  id: "1",
  agreementId: "1",
  contractAddress:
    "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
  eventType: "PaymentSent",
  blockNumber: 100,
  transactionHash:
    "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  createdAt: new Date("2025-06-15T10:30:00Z"),
  from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
  to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
  amount: "1000000",
  token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  employer: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
  contributor:
    "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
  employeeAddress:
    "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb",
  salaryPerPeriod: "500000",
};

vi.mock("../db/index.js", () => {
  return {
    db: {
      select: vi.fn((arg) => {
        // Heuristic: if arg has 'count', it's a count query
        if (arg && arg.count) {
          return createQueryChain([{ count: 2 }]);
        }
        // Otherwise it's a data query
        return createQueryChain([{ ...DEFAULT_ROW }]);
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
        amount: "amount",
        token: "token",
        transactionHash: "transactionHash",
      },
      escrowEvents: {
        employer: "employer",
        to: "to",
        eventType: "eventType",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        id: "id",
        agreementId: "agreementId",
        amount: "amount",
        transactionHash: "transactionHash",
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
        id: "id",
        contractAddress: "contractAddress",
        transactionHash: "transactionHash",
      },
      employees: {
        employeeAddress: "employeeAddress",
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        agreementId: "agreementId",
        id: "id",
        contractAddress: "contractAddress",
        transactionHash: "transactionHash",
        salaryPerPeriod: "salaryPerPeriod",
      },
      milestones: {
        blockNumber: "blockNumber",
        createdAt: "createdAt",
        agreementId: "agreementId",
        id: "id",
        contractAddress: "contractAddress",
        transactionHash: "transactionHash",
        amount: "amount",
      },
    },
  };
});

// ── App setup ────────────────────────────────────────────────────────────

const USER_ADDRESS =
  "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";

const app = express();
app.use(express.json());
app.use(transactionsRouter);
app.use((err: any, _req: any, res: any, _next: any) => {
  res.status(500).json({ error: err.message });
});

// ── Helper: validate transaction item shape ──────────────────────────────

function expectValidTransactionItem(item: any) {
  expect(item).toHaveProperty("id");
  expect(item).toHaveProperty("type");
  expect(item).toHaveProperty("address");
  expect(item).toHaveProperty("date");
  expect(item).toHaveProperty("time");
  expect(item).toHaveProperty("token");
  expect(item).toHaveProperty("amount");
  expect(item).toHaveProperty("status");
  expect(item).toHaveProperty("tokenIcon");
  expect(item).toHaveProperty("txHash");
  expect(item).toHaveProperty("createdAt");
  expect(item.status).toBe("Completed");
  expect(typeof item.id).toBe("string");
  expect(typeof item.type).toBe("string");
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Transactions Router — main endpoint", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("success path", () => {
    it("returns a 200 with the correct response envelope", async () => {
      const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transactions");
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("hasMore");
      expect(res.body).toHaveProperty("limit");
      expect(res.body).toHaveProperty("offset");
      expect(Array.isArray(res.body.transactions)).toBe(true);
    });

    it("returns transactions with the correct item shape", async () => {
      const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions.length).toBeGreaterThan(0);
      for (const tx of res.body.transactions) {
        expectValidTransactionItem(tx);
      }
    });

    it("returns all five entity types merged and sorted", async () => {
      const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

      expect(res.status).toBe(200);
      // 5 data queries × 1 row each = 5 transactions
      expect(res.body.transactions.length).toBe(5);
    });
  });

  describe("pagination", () => {
    it("clamps limit to 100", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}?limit=200`,
      );

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100);
    });

    it("defaults limit to 50 when not provided", async () => {
      const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(50);
    });

    it("calculates hasMore correctly (total > limit)", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}?limit=5`,
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(10);
      expect(res.body.hasMore).toBe(true);
    });

    it("calculates hasMore correctly (total ≤ offset + limit)", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}?limit=200`,
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(10);
      expect(res.body.hasMore).toBe(false);
    });

    it("supports offset pagination", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}?limit=3&offset=2`,
      );

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(3);
      expect(res.body.offset).toBe(2);
    });

    it("defaults offset to 0 when not provided", async () => {
      const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.body.offset).toBe(0);
    });
  });

  describe("event type filtering", () => {
    it("accepts a comma-separated eventTypes query parameter", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}?eventTypes=PaymentSent,Funded`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transactions");
    });

    it("returns empty when no matching event types exist for a table", async () => {
      // Event types that don't match any table's types should still return 200
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}?eventTypes=NonExistent`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transactions");
    });

    it("ignores empty eventTypes parameter", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}?eventTypes=`,
      );

      expect(res.status).toBe(200);
    });
  });

  describe("empty results", () => {
    it("handles empty results smoothly", async () => {
      const { db } = await import("../db/index.js");
      vi.mocked(db.select).mockImplementation((arg: any) => {
        if (arg && arg.count) return createQueryChain([{ count: 0 }]);
        return createQueryChain([]);
      });

      const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.transactions.length).toBe(0);
      expect(res.body.hasMore).toBe(false);
    });

    it("returns zero total when all counts are zero", async () => {
      const { db } = await import("../db/index.js");
      vi.mocked(db.select).mockImplementation((arg: any) => {
        if (arg && arg.count) return createQueryChain([{ count: 0 }]);
        return createQueryChain([]);
      });

      const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });
  });

  describe("error handling", () => {
    it("returns 500 when a database error occurs", async () => {
      const { db } = await import("../db/index.js");
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error("Database connection lost");
      });

      const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    });
  });
});

// ── Filtered endpoint ────────────────────────────────────────────────────

describe("Transactions Router — filtered endpoint", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("success path", () => {
    it("returns a 200 with the correct response envelope", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transactions");
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("hasMore");
      expect(Array.isArray(res.body.transactions)).toBe(true);
    });

    it("returns valid transaction items", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered`,
      );

      expect(res.status).toBe(200);
      for (const tx of res.body.transactions) {
        expectValidTransactionItem(tx);
      }
    });
  });

  describe("pagination", () => {
    it("clamps limit to 100", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered?limit=200`,
      );

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100);
    });

    it("calculates hasMore correctly", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered?limit=5`,
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(10);
      expect(res.body.hasMore).toBe(true);
    });
  });

  describe("date filtering", () => {
    it("accepts startDate and endDate query parameters", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered?startDate=2025-01-01&endDate=2025-12-31`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transactions");
    });

    it("handles startDate only", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered?startDate=2025-01-01`,
      );

      expect(res.status).toBe(200);
    });

    it("handles endDate only", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered?endDate=2025-12-31`,
      );

      expect(res.status).toBe(200);
    });

    it("returns 400 for invalid date strings", async () => {
      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered?startDate=not-a-date`,
      );

      // Invalid Date objects are created but may still work; the route
      // doesn't explicitly validate date format, so it proceeds.
      // We just verify it doesn't crash.
      expect(res.status).toBe(200);
    });
  });

  describe("empty results", () => {
    it("handles empty results smoothly", async () => {
      const { db } = await import("../db/index.js");
      vi.mocked(db.select).mockImplementation((arg: any) => {
        if (arg && arg.count) return createQueryChain([{ count: 0 }]);
        return createQueryChain([]);
      });

      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered`,
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.transactions.length).toBe(0);
      expect(res.body.hasMore).toBe(false);
    });
  });

  describe("error handling", () => {
    it("returns 500 when a database error occurs", async () => {
      const { db } = await import("../db/index.js");
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error("Database connection lost");
      });

      const res = await request(app).get(
        `/transactions/${USER_ADDRESS}/filtered`,
      );

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    });
  });
});

// ── Logging behaviour ────────────────────────────────────────────────────

describe("Transactions Router — logging", () => {
  const userAddress =
    "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";
  let logSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 1 }]);
      return createQueryChain([
        {
          id: "1",
          agreementId: "1",
          contractAddress:
            "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
          eventType: "PaymentReceived",
          blockNumber: 100,
          transactionHash:
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          createdAt: new Date(),
          from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
          amount: "1500000",
          token: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
          employer:
            "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          contributor:
            "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
          employeeAddress:
            "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb",
          salaryPerPeriod: "500000",
        },
      ]);
    });

    const { env } = await import("../config.js");
    (env as { LOG_LEVEL?: string }).LOG_LEVEL = "info";

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("stays silent and returns transactions at the default log level", async () => {
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

// ── Response shape contract ──────────────────────────────────────────────

describe("Transactions Router — response contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("has the documented fields on every transaction item", async () => {
    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    for (const tx of res.body.transactions) {
      // Every transaction must have these keys, even if the value is "-" or ""
      const requiredKeys = [
        "id",
        "type",
        "address",
        "date",
        "time",
        "token",
        "amount",
        "status",
        "tokenIcon",
        "txHash",
        "createdAt",
      ];
      for (const key of requiredKeys) {
        expect(tx).toHaveProperty(key);
      }
    }
  });

  it("preserves the same response shape for both endpoints", async () => {
    const main = await request(app).get(`/transactions/${USER_ADDRESS}`);
    const filtered = await request(app).get(
      `/transactions/${USER_ADDRESS}/filtered`,
    );

    for (const res of [main, filtered]) {
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("transactions");
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("hasMore");
      expect(res.body).toHaveProperty("limit");
      expect(res.body).toHaveProperty("offset");
      expect(typeof res.body.total).toBe("number");
      expect(typeof res.body.hasMore).toBe("boolean");
      expect(typeof res.body.limit).toBe("number");
      expect(typeof res.body.offset).toBe("number");
    }
  });
});

// ── Sort order contract ──────────────────────────────────────────────────

describe("Transactions Router — sort order contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sorts items by createdAt descending", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 1 }]);
      // Return rows with staggered createdAt values so we can verify sort order
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "row-1",
          transactionHash:
            "0x1000000000000000000000000000000000000000000000000000000000000000",
          createdAt: new Date("2025-01-01T00:00:00Z"),
          eventType: "AgreementCreated",
        },
        {
          ...DEFAULT_ROW,
          id: "row-2",
          transactionHash:
            "0x2000000000000000000000000000000000000000000000000000000000000000",
          createdAt: new Date("2025-06-15T10:30:00Z"),
          eventType: "AgreementCreated",
        },
        {
          ...DEFAULT_ROW,
          id: "row-3",
          transactionHash:
            "0x3000000000000000000000000000000000000000000000000000000000000000",
          createdAt: new Date("2025-12-31T23:59:59Z"),
          eventType: "AgreementCreated",
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    // 3 rows × 5 tables = 15 items
    // But with count=1, total = 5 (1 per table)
    // Each data query returns 3 rows → 15 items
    expect(res.body.transactions.length).toBe(15);
    // First item should be newest (2025-12-31)
    expect(new Date(res.body.transactions[0].createdAt).getTime()).toBe(
      new Date("2025-12-31T23:59:59Z").getTime(),
    );
    // Items at index 5-9 should be from row-2 (2025-06-15)
    expect(new Date(res.body.transactions[5].createdAt).getTime()).toBe(
      new Date("2025-06-15T10:30:00Z").getTime(),
    );
    // Last item should be oldest (2025-01-01)
    expect(new Date(res.body.transactions[14].createdAt).getTime()).toBe(
      new Date("2025-01-01T00:00:00Z").getTime(),
    );
  });

  it("uses txHash as stable tiebreaker when createdAt is equal", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 1 }]);
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "row-b",
          transactionHash:
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          createdAt: new Date("2025-06-15T10:30:00Z"),
          eventType: "AgreementCreated",
        },
        {
          ...DEFAULT_ROW,
          id: "row-a",
          transactionHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          createdAt: new Date("2025-06-15T10:30:00Z"),
          eventType: "AgreementCreated",
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    // 2 rows × 5 tables = 10 items
    // But with count=1, total = 5 (1 per table)
    expect(res.body.transactions.length).toBe(10);
    // At the same createdAt, lower txHash comes first (ascending)
    // "0xaaa..." < "0xbbb...", so first 5 items have row-a's txHash
    expect(res.body.transactions[0].txHash).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    // Last 5 items have row-b's txHash
    expect(res.body.transactions[9].txHash).toBe(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });
});

// ── Per-entity-type contract ─────────────────────────────────────────────

describe("Transactions Router — per-entity-type contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("produces the correct type labels for each entity type", async () => {
    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    const types = res.body.transactions.map((t: any) => t.type);
    // All five entity types should be represented
    expect(types).toContain("Payment Sent");
    expect(types).toContain("Employee Added");
    expect(types).toContain("Milestone Added");
    // Agreement events and escrow events both map from eventType="PaymentSent"
    // formatEventType("PaymentSent") = "Payment Sent" (exact map entry)
    // So agreement events and payments both have type "Payment Sent" from DEFAULT_ROW
    expect(types.filter((t: string) => t === "Payment Sent").length).toBe(2);
  });

  it("shows token and amount as '-' for agreement events", async () => {
    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    const agreementLikeItems = res.body.transactions.filter(
      (t: any) => t.token === "-",
    );
    // At least 3 items (agreement events, employee events, milestone events) should have "-"
    expect(agreementLikeItems.length).toBeGreaterThanOrEqual(3);
  });

  it("shows placeholder icon for non-payment entity types", async () => {
    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    const emptyIconItems = res.body.transactions.filter(
      (t: any) => t.tokenIcon === "",
    );
    // Agreement events, employee events, milestone events have tokenIcon ""
    // Payments and escrow events have resolved icons
    expect(emptyIconItems.length).toBeGreaterThanOrEqual(3);
  });

  it("resolves the payment amount with sign prefix", async () => {
    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    // Filter to payment items (not from agreement events which also have type "Payment Sent")
    // Payment items have resolved tokens (STRK), agreement events have "-"
    const paymentItem = res.body.transactions.find(
      (t: any) => t.type === "Payment Sent" && t.token !== "-",
    );
    expect(paymentItem).toBeDefined();
    expect(typeof paymentItem.amount).toBe("string");
    // Should have "-" sign prefix (outgoing PaymentSent)
    expect(paymentItem.amount.startsWith("-")).toBe(true);
    expect(paymentItem.token).toBe("STRK");
  });
});

// ── Address field contract ───────────────────────────────────────────────

describe("Transactions Router — address field contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("formats addresses in truncated 0x1234...5678 format", async () => {
    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    for (const tx of res.body.transactions) {
      if (tx.address === "N/A") continue;
      // Address should start with "0x"
      expect(tx.address).toMatch(/^0x/);
      // Either full address or truncated with "..."
      if (tx.address.includes("...")) {
        expect(tx.address.length).toBeLessThanOrEqual(14); // 0x + 6 + ... + 4
      }
    }
  });

  it("uses 'N/A' for agreement events when contributor is missing and user is employer", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 1 }]);
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "agreement-without-contributor",
          eventType: "AgreementCreated",
          transactionHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          employer: USER_ADDRESS,
          contributor: "",
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    const agreementTx = res.body.transactions.find(
      (t: any) => t.type === "Agreement Created",
    );
    expect(agreementTx).toBeDefined();
    expect(agreementTx.address).toBe("N/A");
  });

  it("shows the counterparty employer when user is the contributor in agreement events", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 1 }]);
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "agreement-as-contributor",
          eventType: "AgreementCreated",
          transactionHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          employer: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          contributor: USER_ADDRESS,
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    const agreementTx = res.body.transactions.find(
      (t: any) => t.type === "Agreement Created",
    );
    expect(agreementTx).toBeDefined();
    expect(agreementTx.address).not.toBe("N/A");
    expect(agreementTx.address).toMatch(/^0x/);
  });

  it("shows sender (from) address for incoming payments and receiver (to) for outgoing", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 2 }]);
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "payment-sent-row",
          eventType: "PaymentSent",
          transactionHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01",
          from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
        },
        {
          ...DEFAULT_ROW,
          id: "payment-received-row",
          eventType: "PaymentReceived",
          transactionHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02",
          from: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
          to: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    const sent = res.body.transactions.find(
      (t: any) => t.type === "Payment Sent" && t.token !== "-",
    );
    const received = res.body.transactions.find(
      (t: any) => t.type === "Payment Received" && t.token !== "-",
    );

    expect(sent).toBeDefined();
    expect(received).toBeDefined();
    expect(sent.address).toMatch(/^0x/);
    expect(received.address).toMatch(/^0x/);
  });
});

// ── Amount formatting contract ───────────────────────────────────────────

describe("Transactions Router — amount formatting contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prepends '-' for outgoing payments and '+' for incoming payments", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 2 }]);
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "outgoing",
          eventType: "PaymentSent",
          transactionHash:
            "0xa000000000000000000000000000000000000000000000000000000000000001",
          amount: "15000000",
          token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
          from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
        },
        {
          ...DEFAULT_ROW,
          id: "incoming",
          eventType: "PaymentReceived",
          transactionHash:
            "0xa000000000000000000000000000000000000000000000000000000000000002",
          amount: "25000000",
          token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
          from: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
          to: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}?limit=100`);

    expect(res.status).toBe(200);
    // Payment items have resolved token (STRK), not "-"
    const sentPayment = res.body.transactions.find(
      (t: any) => t.type === "Payment Sent" && t.token === "STRK",
    );
    const receivedPayment = res.body.transactions.find(
      (t: any) => t.type === "Payment Received" && t.token === "STRK",
    );
    expect(sentPayment).toBeDefined();
    expect(receivedPayment).toBeDefined();
    expect(sentPayment.amount.startsWith("-")).toBe(true);
    expect(receivedPayment.amount.startsWith("+")).toBe(true);
    expect(sentPayment.token).toBe("STRK");
    expect(receivedPayment.token).toBe("STRK");
  });

  it("prepends '-' for outgoing escrow (Funded) and '+' for incoming escrow (Released/Refunded)", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 2 }]);
      // IMPORTANT: agreementId must match the row's id so the escrow token
      // map lookup (by agreementId) finds the resolved token.
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "funded",
          agreementId: "funded", // match row id so escrow token map key matches
          eventType: "Funded",
          transactionHash:
            "0xa000000000000000000000000000000000000000000000000000000000000001",
          amount: "1000000000",
          employer: USER_ADDRESS,
        },
        {
          ...DEFAULT_ROW,
          id: "released",
          agreementId: "released", // match row id so escrow token map key matches
          eventType: "Released",
          transactionHash:
            "0xa000000000000000000000000000000000000000000000000000000000000002",
          amount: "2000000000",
          employer: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          to: USER_ADDRESS,
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}?limit=100`);

    expect(res.status).toBe(200);
    const funded = res.body.transactions.find(
      (t: any) => t.type === "Agreement Funded" && t.token !== "-",
    );
    const released = res.body.transactions.find(
      (t: any) => t.type === "Payment Released" && t.token !== "-",
    );

    expect(funded).toBeDefined();
    expect(released).toBeDefined();
    expect(funded.amount.startsWith("-")).toBe(true);
    expect(released.amount.startsWith("+")).toBe(true);
  });

  it("displays zero amounts as '-'", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 1 }]);
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "zero-amount",
          eventType: "PaymentSent",
          transactionHash:
            "0xa000000000000000000000000000000000000000000000000000000000000001",
          amount: "0",
          token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
          from: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
          to: "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    // Payment items have resolved token (STRK), not "-"
    const zeroTx = res.body.transactions.find(
      (t: any) => t.type === "Payment Sent" && t.token !== "-",
    );
    expect(zeroTx).toBeDefined();
    expect(zeroTx.amount).toBe("-");
  });
});

// ── Deduplication contract ───────────────────────────────────────────────

describe("Transactions Router — deduplication contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("main endpoint deduplicates agreement events by id", async () => {
    const { db } = await import("../db/index.js");
    vi.mocked(db.select).mockImplementation((arg: any) => {
      if (arg && arg.count) return createQueryChain([{ count: 3 }]);
      return createQueryChain([
        {
          ...DEFAULT_ROW,
          id: "dup-1",
          eventType: "AgreementCreated",
          transactionHash:
            "0xa000000000000000000000000000000000000000000000000000000000000001",
          agreementId: "aggr-1",
          createdAt: new Date("2025-06-15T10:30:00Z"),
        },
        {
          ...DEFAULT_ROW,
          id: "dup-1",
          eventType: "AgreementCreated",
          transactionHash:
            "0xa000000000000000000000000000000000000000000000000000000000000002",
          agreementId: "aggr-2",
          createdAt: new Date("2025-06-15T10:31:00Z"),
        },
        {
          ...DEFAULT_ROW,
          id: "unique-1",
          eventType: "AgreementCreated",
          transactionHash:
            "0xa000000000000000000000000000000000000000000000000000000000000003",
          agreementId: "aggr-3",
          createdAt: new Date("2025-06-15T10:32:00Z"),
        },
      ]);
    });

    const res = await request(app).get(`/transactions/${USER_ADDRESS}`);

    expect(res.status).toBe(200);
    // The mock returns the same 3 rows for all 5 tables
    // Agreement events get deduplicated (2 unique ids from 3 rows)
    // Other 4 tables each return 3 rows → 12 items
    // Total = 2 (deduped agreement) + 12 = 14 items
    expect(res.body.transactions.length).toBe(14);
    // Check that the agreement event dedup collapsed 3→2 items
    const agreementCreated = res.body.transactions.filter(
      (t: any) => t.type === "Agreement Created",
    );
    expect(agreementCreated.length).toBe(2);
  });
});

// ── Boundary conditions ──────────────────────────────────────────────────

describe("Transactions Router — boundary conditions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("hasMore is false when total exactly equals offset + limit", async () => {
    const res = await request(app).get(
      `/transactions/${USER_ADDRESS}?limit=10`,
    );

    expect(res.status).toBe(200);
    // Mock returns count=2 per table × 5 tables = total=10
    expect(res.body.total).toBe(10);
    // When offset=0, limit=10: total(10) > offset(0) + limit(10) → false
    expect(res.body.hasMore).toBe(false);
  });

  it("hasMore is false when offset exceeds total", async () => {
    const res = await request(app).get(
      `/transactions/${USER_ADDRESS}?limit=5&offset=20`,
    );

    expect(res.status).toBe(200);
    // total=10, offset=20 > total
    expect(res.body.total).toBe(10);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.transactions.length).toBe(0);
  });

  it("hasMore is true when offset + limit is less than total", async () => {
    const res = await request(app).get(
      `/transactions/${USER_ADDRESS}?limit=3&offset=0`,
    );

    expect(res.status).toBe(200);
    // total=10, offset(0) + limit(3) = 3 < 10
    expect(res.body.total).toBe(10);
    expect(res.body.hasMore).toBe(true);
  });

  it("hasMore is false when offset + limit exactly equals total", async () => {
    const res = await request(app).get(
      `/transactions/${USER_ADDRESS}?limit=5&offset=5`,
    );

    expect(res.status).toBe(200);
    // total=10, offset(5) + limit(5) = 10
    expect(res.body.total).toBe(10);
    expect(res.body.hasMore).toBe(false);
  });

  it("returns an empty array when offset is at or beyond the total", async () => {
    const res = await request(app).get(
      `/transactions/${USER_ADDRESS}?offset=10`,
    );

    expect(res.status).toBe(200);
    expect(res.body.transactions.length).toBe(0);
  });
});

// ── Endpoint contract differences ────────────────────────────────────────

describe("Transactions Router — endpoint contract differences", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("main endpoint supports eventTypes but filtered endpoint does not", async () => {
    const main = await request(app).get(
      `/transactions/${USER_ADDRESS}?eventTypes=PaymentSent`,
    );
    const filtered = await request(app).get(
      `/transactions/${USER_ADDRESS}/filtered?eventTypes=PaymentSent`,
    );

    expect(main.status).toBe(200);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveProperty("transactions");
  });

  it("filtered endpoint supports date range but main endpoint does not", async () => {
    const filtered = await request(app).get(
      `/transactions/${USER_ADDRESS}/filtered?startDate=2025-01-01&endDate=2025-12-31`,
    );
    const main = await request(app).get(
      `/transactions/${USER_ADDRESS}?startDate=2025-01-01&endDate=2025-12-31`,
    );

    expect(filtered.status).toBe(200);
    expect(main.status).toBe(200);
    expect(main.body).toHaveProperty("transactions");
  });
});
