import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  dbReadinessMiddleware,
  isApplicationReady,
  setApplicationReady,
} from "./db-readiness.js";

function makeApp() {
  const app = express();
  app.use(dbReadinessMiddleware);
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/ready", (_req, res) => res.json({ ok: true }));
  app.get("/api/v1/example", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("dbReadinessMiddleware", () => {
  afterEach(() => {
    setApplicationReady(true);
  });

  it("allows /health and /ready when the application is not ready", async () => {
    setApplicationReady(false);
    const app = makeApp();

    const health = await request(app).get("/health");
    const ready = await request(app).get("/ready");

    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
  });

  it("returns 503 for other routes until the application is ready", async () => {
    setApplicationReady(false);
    const app = makeApp();

    const blocked = await request(app).get("/api/v1/example");

    expect(blocked.status).toBe(503);
    expect(blocked.body).toEqual({
      error: "Service unavailable",
      message: "Database is not ready",
    });
    expect(isApplicationReady()).toBe(false);
  });

  it("passes traffic through after readiness is confirmed", async () => {
    setApplicationReady(false);
    const app = makeApp();

    setApplicationReady(true);
    const response = await request(app).get("/api/v1/example");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
