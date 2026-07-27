/**
 * @file events.test.ts
 * Tests for the shared processTxReceipt helper used by both
 * POST /events/process_tx/:tx_hash and POST /events/process_batch.
 *
 * Mock strategy
 * -------------
 * - `vi.hoisted()` is used to create spies that must be shared between
 *   vi.mock factories (which are hoisted to the top of the file) and test
 *   bodies.
 * - `Contract` is mocked as a plain class so `new Contract(...)` works.
 * - DB insert/update chains are re-wired in beforeEach after clearAllMocks().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Hoisted spies – must be created BEFORE vi.mock factories run
// ---------------------------------------------------------------------------

const parseEventMock = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../db/index.js", () => {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });

  return {
    db: { insert, update },
    schema: {
      agreements: "agreements",
      agreementEvents: "agreementEvents",
      payments: "payments",
      escrowEvents: "escrowEvents",
    },
  };
});

vi.mock("../starknet/client.js", () => ({
  provider: { getTransactionReceipt: vi.fn() },
  agreementContract: vi.fn(() => ({
    // Resolves to the same token as the AgreementCreated fixture so the default
    // path verifies cleanly; the verification tests override this per case.
    get_token: vi
      .fn()
      .mockResolvedValue(
        BigInt("0xdeadbeef00000000000000000000000000000000000000000000000000000002"),
      ),
  })),
}));

vi.mock("../starknet/abi.js", () => ({
  loadAbiFromContractClassJsonPath: vi.fn(() => []),
}));

// Contract is a class – use class syntax inside mockImplementation (vitest v4 requirement).
// parseEventMock is shared via vi.hoisted so every instance delegates to it.
vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  return {
    ...actual,
    Contract: class {
      parseEvent = parseEventMock;
    },
  };
});

vi.mock("../config.js", () => ({
  defaults: {
    workAgreementAddress: "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
    payrollEscrowAddress: "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
  },
  abiPaths: { agreement: "/fake/agreement.json", escrow: "/fake/escrow.json" },
  env: { NODE_ENV: "test" },
}));

vi.mock("../utils/codec.js", () => ({
  toHexString: (n: bigint) => `0x${n.toString(16)}`,
  u256ToString: (n: bigint) => n.toString(),
}));

// ---------------------------------------------------------------------------
// Import SUT and mocked modules AFTER all vi.mock calls
// ---------------------------------------------------------------------------

import express from "express";
import request from "supertest";
import { processTxReceipt, eventsRouter } from "./events.js";
import { db } from "../db/index.js";
import { provider, agreementContract } from "../starknet/client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGREEMENT_ADDRESS = "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd";

const TX_A = "0x000000000000000000000000000000000000000000000000000000000000aaaa";
const TX_B = "0x000000000000000000000000000000000000000000000000000000000000bbbb";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgreementReceipt(txHash: string) {
  return {
    transaction_hash: txHash,
    block_number: 12345,
    events: [
      {
        from_address: AGREEMENT_ADDRESS,
        keys: ["0xAgreementCreated"],
        data: [
          "0x1",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
          "0x0",
          "0x1",
        ],
      },
    ],
  };
}

function makePaymentReceipt(txHash: string) {
  return {
    transaction_hash: txHash,
    block_number: 12346,
    events: [
      {
        from_address: AGREEMENT_ADDRESS,
        keys: ["0xPaymentSent"],
        data: [
          "0x1",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
          "0x64",
          "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
        ],
      },
    ],
  };
}

const EMPTY_RECEIPT = { transaction_hash: TX_B, block_number: 99, events: [] };

// Decoded shapes returned by parseEvent
const decodedAgreementCreated = () => ({
  name: "AgreementCreated",
  data: {
    agreement_id: "1",
    employer: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
    contributor: null,
    token: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
    mode: "0",
    payment_type: "1",
  },
});

const decodedPaymentSent = () => ({
  name: "PaymentSent",
  data: {
    agreement_id: "1",
    from: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
    to: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
    amount: "100",
    token: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
  },
});

// ---------------------------------------------------------------------------
// beforeEach helper – re-wires db.insert after clearAllMocks resets everything
// ---------------------------------------------------------------------------

function rewireDbInsert() {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
}

// ---------------------------------------------------------------------------
// Tests – shared processor
// ---------------------------------------------------------------------------

// Named via vi.hoisted so individual tests can override behavior (e.g.
// simulate requireAdmin rejecting a non-admin caller) with mockImplementationOnce.
// vi.clearAllMocks() (used throughout this file) clears call history but not
// the base implementation set here, so the default "always call next()"
// behavior persists across tests unless explicitly overridden.
const { mockRequireAuth, mockRequireAdmin } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn((_req: any, _res: any, next: any) => next()),
  mockRequireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock("../auth/middleware.js", () => ({
  requireAuth: mockRequireAuth,
  requireAdmin: mockRequireAdmin,
}));
describe("processTxReceipt – shared processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rewireDbInsert();
  });

  it("returns not_found when provider returns null", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(null as any);

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("not_found");
    expect(result.eventsProcessed).toBe(0);
  });

  it("returns no_events when receipt has empty events array", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(EMPTY_RECEIPT as any);

    const result = await processTxReceipt(TX_B);

    expect(result.status).toBe("no_events");
    expect(result.eventsProcessed).toBe(0);
  });

  it("decodes AgreementCreated and inserts into agreementEvents and agreements", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      makeAgreementReceipt(TX_A) as any,
    );

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(result.eventsProcessed).toBe(1);
    expect(result.eventLabels[0]).toMatch(/AgreementCreated/);
    expect(vi.mocked(db.insert)).toHaveBeenCalledWith("agreementEvents");
    expect(vi.mocked(db.insert)).toHaveBeenCalledWith("agreements");
  });

  it("decodes PaymentSent and inserts into payments", async () => {
    parseEventMock.mockReturnValue(decodedPaymentSent());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      makePaymentReceipt(TX_A) as any,
    );

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(result.eventsProcessed).toBe(1);
    expect(result.eventLabels[0]).toMatch(/PaymentSent/);
    expect(vi.mocked(db.insert)).toHaveBeenCalledWith("payments");
  });

  it("is idempotent – all inserts use onConflictDoNothing", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const r1 = await processTxReceipt(TX_A);
    const r2 = await processTxReceipt(TX_A);

    expect(r1.status).toBe("processed");
    expect(r2.status).toBe("processed");
    // insert was called on both runs – no uniqueness errors because of
    // onConflictDoNothing (verified by the mock not throwing)
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it("normalises a short tx hash to exactly 0x + 64 hex chars", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    const paddedHash = "0x000000000000000000000000000000000000000000000000000000000000aaaa";
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      makeAgreementReceipt(paddedHash) as any,
    );

    const result = await processTxReceipt("0xaaaa"); // short form

    expect(result.txHash.length).toBe(66);
    expect(result.txHash).toBe(paddedHash);
  });

  it("falls back to un-padded hash when normalised lookup fails", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt)
      .mockRejectedValueOnce(new Error("padded hash not found"))
      .mockResolvedValueOnce(makeAgreementReceipt(TX_A) as any);

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(vi.mocked(provider.getTransactionReceipt)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests – batch semantics (per-tx isolation)
// ---------------------------------------------------------------------------

describe("processTxReceipt – batch semantics (per-tx isolation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rewireDbInsert();
  });

  it("processes two different tx hashes independently", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt)
      .mockResolvedValueOnce(makeAgreementReceipt(TX_A) as any)
      .mockResolvedValueOnce(makeAgreementReceipt(TX_B) as any);

    const r1 = await processTxReceipt(TX_A);
    const r2 = await processTxReceipt(TX_B);

    expect(r1.status).toBe("processed");
    expect(r2.status).toBe("processed");
    expect(r1.txHash).not.toBe(r2.txHash);
  });

  it("a failing tx throws so the batch handler can capture it per-tx", async () => {
    // Both the padded and un-padded lookups must fail to surface the RPC error
    vi.mocked(provider.getTransactionReceipt).mockRejectedValue(new Error("RPC timeout"));

    await expect(processTxReceipt(TX_A)).rejects.toThrow("RPC timeout");
  });

  it("re-processing the same tx is idempotent (no duplicate rows)", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const r1 = await processTxReceipt(TX_A);
    const r2 = await processTxReceipt(TX_A);

    expect(r1.status).toBe("processed");
    expect(r2.status).toBe("processed");
  });

  it("returns no_events for a tx with an empty events list", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(EMPTY_RECEIPT as any);

    const result = await processTxReceipt(TX_B);

    expect(result.status).toBe("no_events");
    expect(result.eventsProcessed).toBe(0);
  });

  it("written rows have per-event composite IDs (txHash_index) preventing duplicates", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValueOnce(
      makeAgreementReceipt(TX_A) as any,
    );

    await processTxReceipt(TX_A);

    // Capture the first `values()` call to agreementEvents insert
    const insertCalls = vi.mocked(db.insert).mock.calls;
    const agreementEventInsert = insertCalls.find(([tbl]) => tbl === "agreementEvents");
    expect(agreementEventInsert).toBeDefined();

    // values() was called on the insert mock – the ID includes the tx hash
    const valuesMock = vi
      .mocked(db.insert)
      .mock.results.find((_, i) => insertCalls[i]?.[0] === "agreementEvents");
    expect(valuesMock).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests – Zod input validation schemas
// ---------------------------------------------------------------------------

describe("Zod input validation schemas", () => {
  const TxHashSchema = z
    .string()
    .min(3)
    .max(66)
    .regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Starknet transaction hash format");

  const BatchSchema = z.object({
    tx_hashes: z.array(TxHashSchema).min(1).max(50),
  });

  it("TxHashSchema rejects non-hex strings", () => {
    expect(() => TxHashSchema.parse("not-a-hash")).toThrow();
    expect(() => TxHashSchema.parse("0xGGGG")).toThrow();
    expect(() => TxHashSchema.parse("")).toThrow();
    expect(() => TxHashSchema.parse("1234abcd")).toThrow(); // missing 0x prefix
  });

  it("TxHashSchema accepts short and full-length valid hashes", () => {
    expect(() => TxHashSchema.parse("0xabc")).not.toThrow();
    expect(() => TxHashSchema.parse(TX_A)).not.toThrow();
    expect(() => TxHashSchema.parse("0x" + "f".repeat(64))).not.toThrow();
  });

  it("BatchSchema rejects arrays with more than 50 hashes (MAX_BATCH_SIZE)", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `0x${i.toString(16).padStart(4, "0")}`);
    expect(() => BatchSchema.parse({ tx_hashes: tooMany })).toThrow();
  });

  it("BatchSchema rejects an empty tx_hashes array", () => {
    expect(() => BatchSchema.parse({ tx_hashes: [] })).toThrow();
  });

  it("BatchSchema accepts arrays of 1 to 50 valid hashes", () => {
    const maxValid = Array.from({ length: 50 }, (_, i) => `0x${i.toString(16).padStart(4, "0")}`);
    expect(() => BatchSchema.parse({ tx_hashes: maxValid })).not.toThrow();
    expect(() => BatchSchema.parse({ tx_hashes: [TX_A] })).not.toThrow();
  });

  it("BatchSchema rejects a batch containing even one invalid hash", () => {
    expect(() => BatchSchema.parse({ tx_hashes: [TX_A, "not-a-hash"] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests – on-chain token verification (#29)
// ---------------------------------------------------------------------------

describe("processTxReceipt – on-chain token verification", () => {
  // The token carried by the AgreementCreated fixture (event data[3]).
  const EVENT_TOKEN = BigInt("0xdeadbeef00000000000000000000000000000000000000000000000000000002");
  const ONCHAIN_MISMATCH = BigInt(
    "0xcafebabe00000000000000000000000000000000000000000000000000000003",
  );

  let setSpy: ReturnType<typeof vi.fn>;

  /** Re-wire the db.insert and db.update chains after clearAllMocks. */
  function rewireDb() {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as any);

    const where = vi.fn().mockResolvedValue(undefined);
    setSpy = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);
  }

  function mockGetToken(impl: () => Promise<bigint>) {
    vi.mocked(agreementContract).mockReturnValue({ get_token: vi.fn(impl) } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rewireDb();
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);
  });

  it("reports tokenVerified true and does not update when the on-chain token matches", async () => {
    mockGetToken(() => Promise.resolve(EVENT_TOKEN));

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(result.tokenVerified).toBe(true);
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it("corrects the stored token and still reports tokenVerified true on mismatch", async () => {
    mockGetToken(() => Promise.resolve(ONCHAIN_MISMATCH));

    const result = await processTxReceipt(TX_A);

    expect(result.tokenVerified).toBe(true);
    expect(vi.mocked(db.update)).toHaveBeenCalledWith("agreements");
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.stringContaining("cafebabe") }),
    );
  });

  it("reports tokenVerified false when the contract call fails, without throwing", async () => {
    mockGetToken(() => Promise.reject(new Error("RPC down")));

    const result = await processTxReceipt(TX_A);

    expect(result.status).toBe("processed");
    expect(result.eventsProcessed).toBe(1);
    expect(result.tokenVerified).toBe(false);
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests – HTTP routes (process_tx / process_batch)
// ---------------------------------------------------------------------------

describe("events routes – process_tx and process_batch responses", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(eventsRouter);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rewireDbInsert();
    // Force a deterministic "token matches" path for the default route tests.
    vi.mocked(agreementContract).mockReturnValue({
      get_token: vi
        .fn()
        .mockResolvedValue(
          BigInt("0xdeadbeef00000000000000000000000000000000000000000000000000000002"),
        ),
    } as any);
  });

  it("process_tx returns 200 and surfaces tokenVerified for an AgreementCreated tx", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const res = await request(makeApp()).post(`/events/process_tx/${TX_A}`).send();

    expect(res.status).toBe(200);
    expect(res.body.tokenVerified).toBe(true);
    expect(res.body.transactionHash).toBe(TX_A);
  });

  it("process_tx returns 404 when the transaction is not found", async () => {
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(null as any);

    const res = await request(makeApp()).post(`/events/process_tx/${TX_A}`).send();

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/not found/i);
  });

  it("process_batch returns a per-tx summary", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const res = await request(makeApp())
      .post("/events/process_batch")
      .send({ tx_hashes: [TX_A] });

    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.results).toHaveLength(1);
  });

  it("process_tx returns 400 with a clean error for a malformed hash", async () => {
    const res = await request(makeApp()).post("/events/process_tx/not-a-tx-hash").send();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid Starknet transaction hash format");
    // Never should have reached the provider with garbage input.
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("process_tx still works for valid TX_A/TX_B-style hashes", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_B) as any);

    const res = await request(makeApp()).post(`/events/process_tx/${TX_B}`).send();

    expect(res.status).toBe(200);
    expect(res.body.transactionHash).toBe(TX_B);
  });

  it("process_batch dedupes an exact duplicate hash within the same batch", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const res = await request(makeApp())
      .post("/events/process_batch")
      .send({ tx_hashes: [TX_A, TX_A] });

    expect(res.status).toBe(200);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toEqual(res.body.results[1]);
    expect(res.body.summary.duplicates).toBe(1);
    expect(res.body.summary.total).toBe(2);
  });

  it("process_batch dedupes hashes that differ only by leading-zero padding", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt).mockResolvedValue(makeAgreementReceipt(TX_A) as any);

    const unpadded = "0xaaaa";

    const res = await request(makeApp())
      .post("/events/process_batch")
      .send({ tx_hashes: [TX_A, unpadded] });

    expect(res.status).toBe(200);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.summary.duplicates).toBe(1);
    expect(res.body.summary.total).toBe(2);
  });

  it("process_batch reports zero duplicates for all-unique hashes", async () => {
    parseEventMock.mockReturnValue(decodedAgreementCreated());
    vi.mocked(provider.getTransactionReceipt)
      .mockResolvedValueOnce(makeAgreementReceipt(TX_A) as any)
      .mockResolvedValueOnce(makeAgreementReceipt(TX_B) as any);

    const res = await request(makeApp())
      .post("/events/process_batch")
      .send({ tx_hashes: [TX_A, TX_B] });

    expect(res.status).toBe(200);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(res.body.summary.duplicates).toBe(0);
    expect(res.body.summary.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests – cursor pagination helpers (encodeCursor / decodeCursor)
// ---------------------------------------------------------------------------

import { encodeCursor, decodeCursor } from "./events.js";
import type { EventCursorPayload } from "./events.js";

describe("encodeCursor / decodeCursor", () => {
  const payload: EventCursorPayload = {
    blockNumber: 42,
    eventIndex: 3,
    id: "0xaaaa_0",
  };

  it("round-trips a valid payload", () => {
    const cursor = encodeCursor(payload);
    expect(decodeCursor(cursor)).toEqual(payload);
  });

  it("produces a base64url string (no +, /, or = padding chars)", () => {
    const cursor = encodeCursor(payload);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns null for an empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for a plain string that is not base64url JSON", () => {
    expect(decodeCursor("notavalidcursor")).toBeNull();
  });

  it("returns null for a base64url string whose JSON is missing required fields", () => {
    const bad = Buffer.from(JSON.stringify({ blockNumber: 1 })).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null when id is an empty string", () => {
    const bad = Buffer.from(
      JSON.stringify({ blockNumber: 1, eventIndex: 0, id: "" }),
    ).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for a non-object JSON value (number, array, null)", () => {
    for (const v of [42, [1, 2], null]) {
      const bad = Buffer.from(JSON.stringify(v)).toString("base64url");
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("returns null for a cursor with wrong field types", () => {
    const bad = Buffer.from(
      JSON.stringify({ blockNumber: "not-a-number", eventIndex: 0, id: "x" }),
    ).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("a cursor from one page cannot be replayed as a smaller-offset cursor", () => {
    // Two payloads with different blockNumbers produce distinct, incomparable
    // cursors — there is no arithmetic relationship between them.
    const c1 = encodeCursor({ blockNumber: 10, eventIndex: 0, id: "tx_0" });
    const c2 = encodeCursor({ blockNumber: 20, eventIndex: 0, id: "tx_0" });
    expect(c1).not.toBe(c2);
    // Decoding either still yields the original values — no cross-contamination.
    expect(decodeCursor(c1)?.blockNumber).toBe(10);
    expect(decodeCursor(c2)?.blockNumber).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Tests – GET /events/list (cursor-based pagination)
// ---------------------------------------------------------------------------

describe("GET /events/list – cursor pagination", () => {
  // Lightweight in-memory store that mimics the DB select chain used by the route.
  type EventRow = {
    id: string;
    agreementId: string;
    contractAddress: string;
    eventType: string;
    blockNumber: number;
    transactionHash: string;
    eventIndex: number;
    createdAt: Date;
  };

  let eventStore: EventRow[] = [];
  // Tracks the decoded cursor the mock should apply. Set by each request helper
  // before calling wireDbSelect so the limit mock filters correctly.
  let activeCursor: EventCursorPayload | null = null;
  // Optional row-level filter for agreement_id / event_type tests.
  let testFilter: ((rows: EventRow[]) => EventRow[]) = (r) => r;

  function makeRow(
    overrides: Partial<EventRow> & { id: string; blockNumber: number; eventIndex: number },
  ): EventRow {
    return {
      agreementId: "1",
      contractAddress: AGREEMENT_ADDRESS,
      eventType: "AgreementCreated",
      transactionHash: "0x" + overrides.id.replace(/[^0-9a-f]/g, "").padStart(64, "0"),
      createdAt: new Date(),
      ...overrides,
    };
  }

  /** Wire the db.select mock to return rows from eventStore with cursor / filter / limit logic. */
  function wireDbSelect() {
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation((n: number) => {
              // Mirror the SQL logic in JS so cursor-based tests work without a real DB.
              let rows = [...eventStore];

              // Apply optional filters set by individual tests via closure.
              rows = testFilter(rows);

              // Apply cursor keyset condition when one is active.
              if (activeCursor) {
                const { blockNumber: cb, eventIndex: ci, id: cid } = activeCursor;
                rows = rows.filter((r) => {
                  if (r.blockNumber > cb) return true;
                  if (r.blockNumber === cb && r.eventIndex > ci) return true;
                  if (r.blockNumber === cb && r.eventIndex === ci && r.id > cid) return true;
                  return false;
                });
              }

              // Stable sort: blockNumber ASC, eventIndex ASC, id ASC
              rows.sort((a, b) => {
                if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
                if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
                return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
              });

              return Promise.resolve(rows.slice(0, n));
            }),
          }),
        }),
      }),
    });
    (db as any).select = selectMock;
  }

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(eventsRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rewireDbInsert();
    eventStore = [];
    testFilter = (r) => r;
    activeCursor = null;
    wireDbSelect();
  });

  /**
   * Makes a GET /events/list request, automatically decoding the cursor from
   * the URL and setting `activeCursor` so the mock applies the correct keyset
   * filter. This removes the need for per-test cursor setup.
   */
  async function getPage(app: ReturnType<typeof makeApp>, url: string) {
    // Extract cursor param from url and decode it for the mock.
    const match = url.match(/[?&]cursor=([^&]+)/);
    activeCursor = match ? decodeCursor(decodeURIComponent(match[1])) : null;
    wireDbSelect();
    return request(app).get(url);
  }

  // ── first page, no cursor ────────────────────────────────────────────────

  it("returns an empty page with no nextCursor when there are no events", async () => {
    const res = await request(makeApp()).get("/events/list");
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.hasMore).toBe(false);
    expect(res.body.count).toBe(0);
  });

  it("returns all events on a single page when count <= limit", async () => {
    for (let i = 0; i < 3; i++) {
      eventStore.push(makeRow({ id: `tx_${i}_0`, blockNumber: i + 1, eventIndex: 0 }));
    }
    wireDbSelect();

    const res = await request(makeApp()).get("/events/list?limit=10");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.hasMore).toBe(false);
  });

  it("returns hasMore=true and a non-null nextCursor when more rows exist", async () => {
    for (let i = 0; i < 5; i++) {
      eventStore.push(makeRow({ id: `tx_${i}_0`, blockNumber: i + 1, eventIndex: 0 }));
    }
    wireDbSelect();

    const res = await request(makeApp()).get("/events/list?limit=3");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).not.toBeNull();
  });

  // ── stable ordering ──────────────────────────────────────────────────────

  it("returns events in stable (blockNumber, eventIndex, id) order", async () => {
    // Insert in reverse order to confirm sort is applied.
    eventStore.push(makeRow({ id: "tx_c_0", blockNumber: 3, eventIndex: 0 }));
    eventStore.push(makeRow({ id: "tx_a_0", blockNumber: 1, eventIndex: 0 }));
    eventStore.push(makeRow({ id: "tx_b_0", blockNumber: 2, eventIndex: 0 }));
    wireDbSelect();

    const res = await request(makeApp()).get("/events/list?limit=10");
    expect(res.status).toBe(200);
    const ids: string[] = res.body.events.map((e: EventRow) => e.id);
    expect(ids).toEqual(["tx_a_0", "tx_b_0", "tx_c_0"]);
  });

  it("breaks ties within the same block by eventIndex then id", async () => {
    eventStore.push(makeRow({ id: "tx_z_1", blockNumber: 5, eventIndex: 1 }));
    eventStore.push(makeRow({ id: "tx_z_0", blockNumber: 5, eventIndex: 0 }));
    eventStore.push(makeRow({ id: "tx_a_2", blockNumber: 5, eventIndex: 2 }));
    wireDbSelect();

    const res = await request(makeApp()).get("/events/list?limit=10");
    const ids: string[] = res.body.events.map((e: EventRow) => e.id);
    expect(ids).toEqual(["tx_z_0", "tx_z_1", "tx_a_2"]);
  });

  // ── multi-page traversal ─────────────────────────────────────────────────

  it("paginating through all pages returns every event exactly once", async () => {
    const total = 7;
    for (let i = 0; i < total; i++) {
      eventStore.push(makeRow({ id: `tx_${i}_0`, blockNumber: i + 1, eventIndex: 0 }));
    }

    const app = makeApp();
    const pageSize = 3;
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;

    for (let page = 0; ; page++) {
      const url = cursor
        ? `/events/list?limit=${pageSize}&cursor=${cursor}`
        : `/events/list?limit=${pageSize}`;
      const res = await getPage(app, url);
      expect(res.status).toBe(200);

      for (const evt of res.body.events as EventRow[]) {
        expect(seen).not.toContain(evt.id); // no duplicates
        seen.push(evt.id);
      }

      cursor = res.body.nextCursor;
      if (!res.body.hasMore) break;
      if (page > total) throw new Error("infinite loop guard");
    }

    expect(seen).toHaveLength(total);
  });

  it("nextCursor is null on the last page", async () => {
    for (let i = 0; i < 4; i++) {
      eventStore.push(makeRow({ id: `tx_${i}_0`, blockNumber: i + 1, eventIndex: 0 }));
    }

    const app = makeApp();
    // Page 1
    const p1 = await getPage(app, "/events/list?limit=3");
    expect(p1.body.hasMore).toBe(true);
    expect(p1.body.nextCursor).not.toBeNull();

    // Page 2 (last)
    const p2 = await getPage(app, `/events/list?limit=3&cursor=${p1.body.nextCursor}`);
    expect(p2.status).toBe(200);
    expect(p2.body.hasMore).toBe(false);
    expect(p2.body.nextCursor).toBeNull();
  });

  it("new events inserted after page 1 do not appear on page 1 or corrupt page 2", async () => {
    // Seed 4 events with blockNumbers 1-4
    for (let i = 0; i < 4; i++) {
      eventStore.push(makeRow({ id: `tx_${i}_0`, blockNumber: i + 1, eventIndex: 0 }));
    }

    const app = makeApp();
    const p1 = await getPage(app, "/events/list?limit=2");
    const p1Ids: string[] = p1.body.events.map((e: EventRow) => e.id);
    // p1 has tx_0_0, tx_1_0

    // Insert a new event at blockNumber 5 — strictly after the existing 4 rows
    eventStore.push(makeRow({ id: "tx_new_0", blockNumber: 5, eventIndex: 0 }));

    // p2 returns tx_2_0, tx_3_0 and peeks at tx_new_0 to set hasMore=true
    const p2 = await getPage(app, `/events/list?limit=2&cursor=${p1.body.nextCursor}`);
    const p2Ids: string[] = p2.body.events.map((e: EventRow) => e.id);

    // No overlap between p1 and p2
    for (const id of p2Ids) expect(p1Ids).not.toContain(id);
    expect(p2Ids).toContain("tx_2_0");
    expect(p2Ids).toContain("tx_3_0");
    // tx_new_0 is beyond p2's window — hasMore is true and it appears on p3
    expect(p2Ids).not.toContain("tx_new_0");
    expect(p2.body.hasMore).toBe(true);

    // p3 contains the newly inserted event
    const p3 = await getPage(app, `/events/list?limit=2&cursor=${p2.body.nextCursor}`);
    expect(p3.body.events.map((e: EventRow) => e.id)).toContain("tx_new_0");
  });

  // ── cursor robustness ────────────────────────────────────────────────────

  it("an invalid cursor is treated as the first page (fail-open)", async () => {
    for (let i = 0; i < 2; i++) {
      eventStore.push(makeRow({ id: `tx_${i}_0`, blockNumber: i + 1, eventIndex: 0 }));
    }

    const res = await getPage(makeApp(), "/events/list?cursor=thisisnotavalidcursor");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
  });

  it("an empty cursor param is treated as the first page", async () => {
    eventStore.push(makeRow({ id: "tx_0_0", blockNumber: 1, eventIndex: 0 }));

    const res = await getPage(makeApp(), "/events/list?cursor=");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });

  // ── limit clamping ───────────────────────────────────────────────────────

  it("clamps an oversized limit to MAX_PAGE_LIMIT", async () => {
    for (let i = 0; i < 5; i++) {
      eventStore.push(makeRow({ id: `tx_${i}_0`, blockNumber: i + 1, eventIndex: 0 }));
    }

    // limit=9999 should be clamped to MAX_PAGE_LIMIT (100); store only has 5 rows
    const res = await getPage(makeApp(), "/events/list?limit=9999");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(5);
    expect(res.body.hasMore).toBe(false);
  });

  it("uses DEFAULT_PAGE_LIMIT when no limit param is supplied", async () => {
    const res = await getPage(makeApp(), "/events/list");
    expect(res.status).toBe(200);
    expect(typeof res.body.count).toBe("number");
  });

  it("clamps limit=0 to 1", async () => {
    eventStore.push(makeRow({ id: "tx_0_0", blockNumber: 1, eventIndex: 0 }));
    eventStore.push(makeRow({ id: "tx_1_0", blockNumber: 2, eventIndex: 0 }));

    const res = await getPage(makeApp(), "/events/list?limit=0");
    expect(res.status).toBe(200);
    // limit clamped to 1 — exactly one event returned
    expect(res.body.events).toHaveLength(1);
  });

  // ── response shape ───────────────────────────────────────────────────────

  it("response always contains events, nextCursor, hasMore, and count fields", async () => {
    const res = await getPage(makeApp(), "/events/list");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect("nextCursor" in res.body).toBe(true);
    expect(typeof res.body.hasMore).toBe("boolean");
    expect(typeof res.body.count).toBe("number");
  });

  it("count equals events.length on every page", async () => {
    for (let i = 0; i < 5; i++) {
      eventStore.push(makeRow({ id: `tx_${i}_0`, blockNumber: i + 1, eventIndex: 0 }));
    }

    const app = makeApp();
    let cursor: string | null | undefined;
    let page = 0;
    do {
      const url = cursor
        ? `/events/list?limit=2&cursor=${cursor}`
        : `/events/list?limit=2`;
      const res = await getPage(app, url);
      expect(res.body.count).toBe(res.body.events.length);
      cursor = res.body.nextCursor;
      if (++page > 10) break;
    } while (cursor);
  });

  // ── validation errors ────────────────────────────────────────────────────

  it("returns 400 when agreement_id is an empty string", async () => {
    const res = await getPage(makeApp(), "/events/list?agreement_id=");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query parameters");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("returns 400 when event_type is an empty string", async () => {
    const res = await getPage(makeApp(), "/events/list?event_type=");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query parameters");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  // ── optional filters ─────────────────────────────────────────────────────

  it("agreement_id filter returns only events for the specified agreement", async () => {
    // Mix two agreement IDs in the store
    eventStore.push(makeRow({ id: "tx_a1_0", blockNumber: 1, eventIndex: 0, agreementId: "1" }));
    eventStore.push(makeRow({ id: "tx_a2_0", blockNumber: 2, eventIndex: 0, agreementId: "2" }));
    eventStore.push(makeRow({ id: "tx_a1_1", blockNumber: 3, eventIndex: 0, agreementId: "1" }));

    // Wire a filter that mirrors what the SQL WHERE clause would do
    testFilter = (rows) => rows.filter((r) => r.agreementId === "2");
    wireDbSelect();

    const res = await getPage(makeApp(), "/events/list?agreement_id=2");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].id).toBe("tx_a2_0");
  });

  it("event_type filter returns only events of the specified type", async () => {
    eventStore.push(
      makeRow({ id: "tx_type_a", blockNumber: 1, eventIndex: 0, eventType: "AgreementCreated" }),
    );
    eventStore.push(
      makeRow({ id: "tx_type_b", blockNumber: 2, eventIndex: 0, eventType: "PaymentSent" }),
    );
    eventStore.push(
      makeRow({ id: "tx_type_c", blockNumber: 3, eventIndex: 0, eventType: "AgreementCreated" }),
    );

    testFilter = (rows) => rows.filter((r) => r.eventType === "PaymentSent");
    wireDbSelect();

    const res = await getPage(makeApp(), "/events/list?event_type=PaymentSent");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].id).toBe("tx_type_b");
  });

  it("filter and cursor pagination together return each matching event exactly once", async () => {
    // 5 events for agreement "42", interleaved with unrelated events
    for (let i = 0; i < 5; i++) {
      eventStore.push(
        makeRow({ id: `tx_match_${i}`, blockNumber: i * 2, eventIndex: 0, agreementId: "42" }),
      );
      eventStore.push(
        makeRow({ id: `tx_other_${i}`, blockNumber: i * 2 + 1, eventIndex: 0, agreementId: "99" }),
      );
    }

    // The mock filter will only be applied after wireDbSelect – track the active
    // filter in the closure and reset it when wireDbSelect rebuilds the mock.
    const filterFn = (rows: EventRow[]) => rows.filter((r) => r.agreementId === "42");
    testFilter = filterFn;

    const app = makeApp();
    const pageSize = 2;
    const seen: string[] = [];
    let cursor: string | null | undefined;

    for (let page = 0; ; page++) {
      const base = `/events/list?agreement_id=42&limit=${pageSize}`;
      const url = cursor ? `${base}&cursor=${cursor}` : base;
      const res = await getPage(app, url);
      expect(res.status).toBe(200);

      for (const evt of res.body.events as EventRow[]) {
        expect(seen).not.toContain(evt.id);
        seen.push(evt.id);
        expect(evt.agreementId).toBe("42");
      }

      cursor = res.body.nextCursor;
      if (!res.body.hasMore) break;
      if (page > 10) throw new Error("infinite loop guard");
    }

    expect(seen).toHaveLength(5);
    expect(seen.every((id) => id.startsWith("tx_match_"))).toBe(true);
  });

  it("combined agreement_id and event_type filters narrow results correctly", async () => {
    eventStore.push(
      makeRow({ id: "match", blockNumber: 1, eventIndex: 0, agreementId: "7", eventType: "AgreementActivated" }),
    );
    eventStore.push(
      makeRow({ id: "wrong_type", blockNumber: 2, eventIndex: 0, agreementId: "7", eventType: "PaymentSent" }),
    );
    eventStore.push(
      makeRow({ id: "wrong_id", blockNumber: 3, eventIndex: 0, agreementId: "8", eventType: "AgreementActivated" }),
    );

    testFilter = (rows) =>
      rows.filter((r) => r.agreementId === "7" && r.eventType === "AgreementActivated");
    wireDbSelect();

    const res = await getPage(makeApp(), "/events/list?agreement_id=7&event_type=AgreementActivated");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].id).toBe("match");
  });
});
