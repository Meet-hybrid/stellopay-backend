import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { clearBillingIdempotencyStore, withBillingIdempotency } from "./billing";

function makeApp() {
  const app = express();
  app.use(express.json());

  let executionCount = 0;

  app.post(
    "/billing/test",
    withBillingIdempotency(async (req, res) => {
      executionCount += 1;
      res.status(201).json({ executionCount, body: req.body });
    }),
  );

  return { app, getExecutionCount: () => executionCount };
}

describe("billing idempotency middleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    clearBillingIdempotencyStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearBillingIdempotencyStore();
  });

  it("executes the handler normally when no idempotency key is supplied", async () => {
    const { app, getExecutionCount } = makeApp();

    const first = await request(app).post("/billing/test").send({ amount: 10 });
    const second = await request(app).post("/billing/test").send({ amount: 20 });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ executionCount: 1, body: { amount: 10 } });
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ executionCount: 2, body: { amount: 20 } });
    expect(getExecutionCount()).toBe(2);
  });

  it("reuses the original response for the same idempotency key and body", async () => {
    const { app, getExecutionCount } = makeApp();

    const first = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "key-123")
      .send({ amount: 10 });

    const second = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "key-123")
      .send({ amount: 10 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(getExecutionCount()).toBe(1);
  });

  it("rejects a repeated idempotency key when the body differs", async () => {
    const { app, getExecutionCount } = makeApp();

    const first = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "key-456")
      .send({ amount: 10 });

    const second = await request(app)
      .post("/billing/test")
      .set("Idempotency-Key", "key-456")
      .send({ amount: 20 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      success: false,
      error: "Idempotency key already used with a different request body",
    });
    expect(getExecutionCount()).toBe(1);
  });
});
