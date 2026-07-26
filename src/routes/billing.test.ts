import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Mock setup — follows the same pattern as auth.test.ts
// ---------------------------------------------------------------------------

const {
  dbMock,
  schemaMock,
  mockState,
  eqMock,
  mockRequireAuth,
} = vi.hoisted(() => {
  const mockState = {
    profiles: [] as any[],
    paymentMethods: [] as any[],
    invoices: [] as any[],
  };

  const schema = {
    billingProfiles: {
      id: "id",
      ownerAddress: "ownerAddress",
      profileType: "profileType",
      annualRewardLimit: "annualRewardLimit",
      usedAmount: "usedAmount",
      currency: "currency",
      firstName: "firstName",
      lastName: "lastName",
      email: "email",
      phone: "phone",
      street: "street",
      city: "city",
      state: "state",
      zipCode: "zipCode",
      country: "country",
      taxId: "taxId",
      taxResidency: "taxResidency",
      dateOfBirth: "dateOfBirth",
      companyName: "companyName",
      vatNumber: "vatNumber",
      businessType: "businessType",
      occupation: "occupation",
      website: "website",
      notes: "notes",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    billingPaymentMethods: {
      id: "id",
      profileId: "profileId",
      type: "type",
      displayName: "displayName",
      maskedAccount: "maskedAccount",
      maskedRouting: "maskedRouting",
      email: "email",
      isDefault: "isDefault",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    billingInvoices: {
      id: "id",
      profileId: "profileId",
      invoiceNumber: "invoiceNumber",
      amount: "amount",
      currency: "currency",
      status: "status",
      description: "description",
      issuedAt: "issuedAt",
      paidAt: "paidAt",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  };

  /**
   * Mock drizzle-orm eq — works with the plain string column names in our
   * mock schema (the real drizzle eq expects Drizzle column objects).
   */
  const eqMock = (col: string, val: any) => (row: any) => row[col] === val;

  const db = {
    select: (fields?: any) => ({
      from: (table: any) => ({
        where: (conditionFn: (row: any) => boolean) => {
          let rows: any[];
          if (table === schema.billingProfiles) rows = mockState.profiles;
          else if (table === schema.billingPaymentMethods) rows = mockState.paymentMethods;
          else rows = mockState.invoices;

          const filtered = rows.filter(conditionFn);

          return {
            // Make .where() result thenable — routes that omit .limit() still resolve.
            then: (resolve: (val: any) => void) => resolve(filtered),
            // Allows .where().limit(n) chaining.
            limit: (n: number) => filtered.slice(0, n),
          };
        },
      }),
    }),
  };

  /**
   * Mock requireAuth — accepts any well-formed auth headers and stubs
   * req.auth so ownership checks can run.
   */
  const mockRequireAuth = vi.fn(async (req: any, res: any, next: any) => {
    const addressHeader = req.headers["x-user-address"];
    const authHeader = req.headers["authorization"];

    if (!addressHeader || !authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const address = addressHeader.trim();
    req.auth = { address: address.toLowerCase(), token: authHeader.substring(7).trim() };
    next();
  });

  return { dbMock: db, schemaMock: schema, mockState, eqMock, mockRequireAuth };
});

/** Mutable config state — tests toggle BILLING_ENABLED via this object */
const configState = { BILLING_ENABLED: true };

vi.mock("../db/index.js", () => ({ db: dbMock, schema: schemaMock }));
vi.mock("drizzle-orm", () => ({ eq: eqMock }));
vi.mock("../auth/middleware.js", () => ({
  requireAuth: mockRequireAuth,
  requireAdmin: vi.fn(),
}));
vi.mock("../config.js", () => ({
  env: new Proxy({} as any, {
    get(_target, prop) {
      return configState[prop as string] ?? undefined;
    },
  }),
}));

import { billingRouter } from "./billing";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", billingRouter);
  app.use((_req: any, res: any) => {
    res.status(404).json({ error: "Not found" });
  });
  return app;
}

/** Auth headers for a known test wallet */
const ownerHeaders = (address = "0xabc123") => ({
  "x-user-address": address,
  Authorization: `Bearer valid-session-token`,
});

/** Seed a billing profile and return its id */
function seedProfile(overrides: Record<string, any> = {}) {
  const id = overrides.id ?? "profile-001";
  const row = {
    id,
    ownerAddress: (overrides.ownerAddress ?? "0xabc123").toLowerCase(),
    profileType: "Individual",
    annualRewardLimit: "10000.000000",
    usedAmount: "2500.500000",
    currency: "USD",
    firstName: "Alice",
    lastName: "Example",
    email: "alice@example.com",
    phone: "+1-555-0100",
    street: "123 Main St",
    city: "Metropolis",
    state: "NY",
    zipCode: "10001",
    country: "US",
    taxId: "123-45-6789",
    taxResidency: "US",
    dateOfBirth: "1990-01-01",
    companyName: null,
    vatNumber: null,
    businessType: null,
    occupation: "Engineer",
    website: null,
    notes: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-06-01"),
    ...overrides,
  };
  mockState.profiles.push(row);
  return id;
}

function seedPaymentMethod(profileId: string, overrides: Partial<any> = {}) {
  const row = {
    id: overrides.id ?? `pm-${mockState.paymentMethods.length + 1}`,
    profileId,
    type: "bank_account",
    displayName: "Chase ****1234",
    maskedAccount: "****1234",
    maskedRouting: "****5678",
    email: null,
    isDefault: true,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-06-01"),
    ...overrides,
  };
  mockState.paymentMethods.push(row);
}

function seedInvoice(profileId: string, overrides: Partial<any> = {}) {
  const row = {
    id: overrides.id ?? `inv-${mockState.invoices.length + 1}`,
    profileId,
    invoiceNumber: overrides.invoiceNumber ?? `INV-${1000 + mockState.invoices.length}`,
    amount: "500.000000",
    currency: "USD",
    status: "pending",
    description: "Monthly retainer",
    issuedAt: new Date("2025-06-01"),
    paidAt: null,
    createdAt: new Date("2025-06-01"),
    updatedAt: new Date("2025-06-01"),
    ...overrides,
  };
  mockState.invoices.push(row);
}

// ---------------------------------------------------------------------------

describe("Billing Routes", () => {
  beforeEach(() => {
    mockState.profiles = [];
    mockState.paymentMethods = [];
    mockState.invoices = [];
    configState.BILLING_ENABLED = true;
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Feature flag
  // -----------------------------------------------------------------------

  describe("feature flag (BILLING_ENABLED)", () => {
    it("returns 501 when billing is disabled", async () => {
      configState.BILLING_ENABLED = false;
      const app = makeApp();

      const res = await request(app)
        .get("/api/v1/billing/profiles/profile-001")
        .set(ownerHeaders());

      expect(res.status).toBe(501);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not yet enabled/);
    });
  });

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  describe("authentication (requireAuth)", () => {
    it("returns 401 when no auth headers are present", async () => {
      const app = makeApp();

      const res = await request(app).get("/api/v1/billing/profiles/profile-001");

      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header is missing", async () => {
      const app = makeApp();

      const res = await request(app)
        .get("/api/v1/billing/profiles/profile-001")
        .set("x-user-address", "0xabc123");

      expect(res.status).toBe(401);
    });

    it("returns 401 when x-user-address header is missing", async () => {
      const app = makeApp();

      const res = await request(app)
        .get("/api/v1/billing/profiles/profile-001")
        .set("Authorization", "Bearer valid-token");

      expect(res.status).toBe(401);
    });

    it("returns 401 for a malformed Authorization header", async () => {
      const app = makeApp();

      const res = await request(app)
        .get("/api/v1/billing/profiles/profile-001")
        .set("x-user-address", "0xabc123")
        .set("Authorization", "Token malformed");

      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // Authorization (ownership)
  // -----------------------------------------------------------------------

  describe("authorization (ownership)", () => {
    it("returns 404 when profile exists but belongs to a different owner", async () => {
      const app = makeApp();
      seedProfile({ id: "other-profile", ownerAddress: "0xother999" });

      // Request as 0xabc123, but the profile belongs to 0xother999
      const res = await request(app)
        .get("/api/v1/billing/profiles/other-profile")
        .set(ownerHeaders());

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      // Message must NOT reveal the profile exists — it says "not found"
      expect(res.body.error).toMatch(/not found/);
    });

    it("returns 404 for a non-existent profile (same as 'not yours')", async () => {
      const app = makeApp();

      const res = await request(app)
        .get("/api/v1/billing/profiles/nonexistent-id")
        .set(ownerHeaders());

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not found/);
    });

    it("returns 404 across all 5 endpoints for an unowned profile", async () => {
      const app = makeApp();
      seedProfile({ id: "not-mine", ownerAddress: "0xother" });
      const headers = ownerHeaders();

      const endpoints = [
        "/api/v1/billing/profiles/not-mine",
        "/api/v1/billing/profiles/not-mine/general-information",
        "/api/v1/billing/profiles/not-mine/payment-methods",
        "/api/v1/billing/profiles/not-mine/invoices",
        "/api/v1/billing/profiles/not-mine/summary",
      ];

      for (const url of endpoints) {
        const res = await request(app).get(url).set(headers);
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/);
      }
    });
  });

  // -----------------------------------------------------------------------
  // ProfileId validation
  // -----------------------------------------------------------------------

  describe("profileId validation", () => {
    it("returns 400 for an empty profileId", async () => {
      const app = makeApp();

      // Express collapses consecutive slashes, so a double-slash URL
      // is normalised before matching.  We use an explicit empty segment
      // via a URL-encoded path to exercise the Zod validator.
      const res = await request(app)
        .get("/api/v1/billing/profiles/%20/general-information")
        .set(ownerHeaders());

      // A space-only profileId fails the alphanumeric/dash regex.
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid profileId/);
    });

    it("returns 400 for a profileId with invalid characters", async () => {
      const app = makeApp();

      const res = await request(app)
        .get("/api/v1/billing/profiles/invalid!@#$/general-information")
        .set(ownerHeaders());

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid profileId/);
    });

    it("returns 400 for a profileId over 128 characters", async () => {
      const app = makeApp();
      const longId = "a".repeat(129);

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${longId}/general-information`)
        .set(ownerHeaders());

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid profileId/);
    });

    it("accepts a valid profileId with alphanumeric and dash chars", async () => {
      const app = makeApp();
      seedProfile({ id: "my-profile-123" });

      const res = await request(app)
        .get("/api/v1/billing/profiles/my-profile-123/general-information")
        .set(ownerHeaders());

      expect(res.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Happy-path: each endpoint
  // -----------------------------------------------------------------------

  describe("GET /billing/profiles/:profileId (full profile)", () => {
    it("returns the full billing profile with payment methods and invoices", async () => {
      const app = makeApp();
      const pid = seedProfile();
      seedPaymentMethod(pid);
      seedPaymentMethod(pid, { id: "pm-2", type: "paypal", email: "alice@paypal.com" });
      seedInvoice(pid);
      seedInvoice(pid, { id: "inv-2", invoiceNumber: "INV-1002", amount: "750.000000", status: "paid" });

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { profile, paymentMethods, invoices } = res.body.data;
      expect(profile.id).toBe(pid);
      expect(profile.firstName).toBe("Alice");
      // Sensitive fields must be stripped
      expect(profile.taxId).toBeUndefined();
      expect(profile.dateOfBirth).toBeUndefined();

      expect(paymentMethods).toHaveLength(2);
      expect(invoices).toHaveLength(2);
    });

    it("returns empty arrays when no payment methods or invoices exist", async () => {
      const app = makeApp();
      const pid = seedProfile();

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.paymentMethods).toEqual([]);
      expect(res.body.data.invoices).toEqual([]);
    });
  });

  describe("GET /billing/profiles/:profileId/general-information", () => {
    it("returns identity fields with a computed fullAddress", async () => {
      const app = makeApp();
      const pid = seedProfile();

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}/general-information`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.firstName).toBe("Alice");
      expect(data.email).toBe("alice@example.com");
      expect(data.fullAddress).toBe("123 Main St, Metropolis, NY, 10001, US");
      // Sensitive fields stripped
      expect(data.taxId).toBeUndefined();
      expect(data.dateOfBirth).toBeUndefined();
    });

    it("returns null fullAddress when no address fields are populated", async () => {
      const app = makeApp();
      const pid = seedProfile({
        id: "no-addr",
        street: null,
        city: null,
        state: null,
        zipCode: null,
        country: null,
      });

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}/general-information`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.fullAddress).toBeNull();
    });
  });

  describe("GET /billing/profiles/:profileId/payment-methods", () => {
    it("returns payment methods for the owned profile", async () => {
      const app = makeApp();
      const pid = seedProfile();
      seedPaymentMethod(pid, { id: "pm-1", type: "bank_account", maskedAccount: "****4321" });
      seedPaymentMethod(pid, { id: "pm-2", type: "crypto", maskedAccount: "0x...def" });

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}/payment-methods`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.profileId).toBe(pid);
      expect(res.body.data.paymentMethods).toHaveLength(2);
    });

    it("returns an empty payment methods array when none exist", async () => {
      const app = makeApp();
      const pid = seedProfile();

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}/payment-methods`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.paymentMethods).toEqual([]);
    });
  });

  describe("GET /billing/profiles/:profileId/invoices", () => {
    it("returns invoices for the owned profile", async () => {
      const app = makeApp();
      const pid = seedProfile();
      seedInvoice(pid, { id: "inv-1", invoiceNumber: "INV-2025-001", amount: "1200.000000", status: "paid" });

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}/invoices`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.profileId).toBe(pid);
      expect(res.body.data.invoices).toHaveLength(1);
      expect(res.body.data.invoices[0].invoiceNumber).toBe("INV-2025-001");
    });

    it("returns an empty invoice array when none exist", async () => {
      const app = makeApp();
      const pid = seedProfile();

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}/invoices`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.invoices).toEqual([]);
    });
  });

  describe("GET /billing/profiles/:profileId/summary", () => {
    it("returns a correct reward-limit summary", async () => {
      const app = makeApp();
      const pid = seedProfile({
        id: "summary-test",
        annualRewardLimit: "5000.000000",
        usedAmount: "1500.000000",
        currency: "EUR",
      });

      const res = await request(app)
        .get(`/api/v1/billing/profiles/${pid}/summary`)
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const d = res.body.data;
      expect(d.profileId).toBe("summary-test");
      expect(d.annualRewardLimit).toBe(5000);
      expect(d.usedAmount).toBe(1500);
      expect(d.remainingAmount).toBe(3500);
      expect(d.currency).toBe("EUR");
      expect(d.progressPercentage).toBe(30); // 1500 / 5000 * 100
    });

    it("clamps remainingAmount to 0 when usedAmount exceeds the limit", async () => {
      const app = makeApp();
      seedProfile({
        id: "overused",
        annualRewardLimit: "1000.000000",
        usedAmount: "1500.000000",
      });

      const res = await request(app)
        .get("/api/v1/billing/profiles/overused/summary")
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.remainingAmount).toBe(0);
      expect(res.body.data.usedAmount).toBe(1500);
    });

    it("handles a zero annualRewardLimit gracefully (no division by zero)", async () => {
      const app = makeApp();
      seedProfile({
        id: "zero-limit",
        annualRewardLimit: "0.000000",
        usedAmount: "500.000000",
      });

      const res = await request(app)
        .get("/api/v1/billing/profiles/zero-limit/summary")
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.progressPercentage).toBe(0);
      expect(res.body.data.remainingAmount).toBe(0);
    });

    it("treats null/non-numeric limit values as 0", async () => {
      const app = makeApp();
      seedProfile({
        id: "weird-values",
        annualRewardLimit: null as any,
        usedAmount: null as any,
      });

      const res = await request(app)
        .get("/api/v1/billing/profiles/weird-values/summary")
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data.annualRewardLimit).toBe(0);
      expect(res.body.data.usedAmount).toBe(0);
      expect(res.body.data.progressPercentage).toBe(0);
    });

    it("computes exact progress percentage for fractional amounts", async () => {
      const app = makeApp();
      seedProfile({
        id: "fractional",
        annualRewardLimit: "3000.000000",
        usedAmount: "1000.000000",
      });

      const res = await request(app)
        .get("/api/v1/billing/profiles/fractional/summary")
        .set(ownerHeaders());

      expect(res.status).toBe(200);
      // 1000 / 3000 * 100 = 33.3333... → rounded to 33.33
      expect(res.body.data.progressPercentage).toBeCloseTo(33.33, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Sensitive-data stripping
  // -----------------------------------------------------------------------

  describe("sensitive-field stripping", () => {
    it("never exposes taxId in any endpoint response", async () => {
      const app = makeApp();
      const pid = seedProfile({ taxId: "SSN-TOPSECRET" });

      const endpoints = [
        `/api/v1/billing/profiles/${pid}`,
        `/api/v1/billing/profiles/${pid}/general-information`,
      ];

      for (const url of endpoints) {
        const res = await request(app).get(url).set(ownerHeaders());
        expect(res.status).toBe(200);

        // Check profile object (full) or the top-level data (general-info)
        const profile = res.body.data.profile ?? res.body.data;
        expect(profile.taxId).toBeUndefined();
        expect(profile.dateOfBirth).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles case-insensitive address matching", async () => {
      const app = makeApp();
      // Owner stored lowercase, caller sends mixed-case
      seedProfile({ id: "case-test", ownerAddress: "0xabc123" });

      const res = await request(app)
        .get("/api/v1/billing/profiles/case-test/general-information")
        .set(ownerHeaders("0xABC123")); // mixed-case headers

      expect(res.status).toBe(200);
    });

    it("returns 500 when the database query throws", async () => {
      // We temporarily replace select to throw
      const originalSelect = dbMock.select;
      dbMock.select = () => {
        throw new Error("DB connection lost");
      };

      const app = makeApp();
      seedProfile({ id: "db-fail" });

      const res = await request(app)
        .get("/api/v1/billing/profiles/db-fail/general-information")
        .set(ownerHeaders());

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/Failed/);

      dbMock.select = originalSelect;
    });
  });
});
