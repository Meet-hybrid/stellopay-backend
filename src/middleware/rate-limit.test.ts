import express from "express";
import request from "supertest";
import { describe, it, expect, vi, afterEach } from "vitest";

import { makeLimiter, keyByIp, retryAfterSeconds } from "./rate-limit";

/**
 * Build a minimal app that mounts the given limiter on `/api` and exposes a
 * route that always succeeds when not throttled.
 */
function makeApp(limiter: express.RequestHandler) {
  const app = express();
  // Mirror production: trust the first proxy so X-Forwarded-For is honoured.
  app.set("trust proxy", 1);
  app.use("/api", limiter);
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeLimiter", () => {
  it("returns a usable Express middleware function", () => {
    const limiter = makeLimiter({ name: "test", windowMs: 1000, max: 5 });
    expect(typeof limiter).toBe("function");
  });

  it("allows requests up to max, then returns the 429 envelope", async () => {
    const max = 3;
    const message = "Too many requests, please try again later.";
    const app = makeApp(makeLimiter({ name: "global", windowMs: 60_000, max, message }));

    // First `max` requests succeed.
    for (let i = 0; i < max; i++) {
      const res = await request(app).get("/api/ping");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }

    // The next request exceeds the limit and is rejected with the envelope.
    const blocked = await request(app).get("/api/ping");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: message });
    expect(blocked.headers["content-type"]).toMatch(/application\/json/);
  });

  it("uses the default message when none is supplied", async () => {
    const app = makeApp(makeLimiter({ name: "default", windowMs: 60_000, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    const blocked = await request(app).get("/api/ping");

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many requests, please try again later." });
  });

  it("respects a configured window/max independently per limiter", async () => {
    // Two limiters with different maxes mounted on separate apps must not
    // share state and must each enforce their own configured max.
    const looseApp = makeApp(makeLimiter({ name: "loose", windowMs: 60_000, max: 5 }));
    const tightApp = makeApp(makeLimiter({ name: "tight", windowMs: 60_000, max: 1 }));

    // tight: 1 ok then 429.
    await request(tightApp).get("/api/ping").expect(200);
    await request(tightApp).get("/api/ping").expect(429);

    // loose: still serving after the tight limiter is exhausted.
    for (let i = 0; i < 5; i++) {
      await request(looseApp).get("/api/ping").expect(200);
    }
    await request(looseApp).get("/api/ping").expect(429);
  });

  it("honours a skip predicate (e.g. health checks are never throttled)", async () => {
    const app = express();
    const limiter = makeLimiter({
      name: "skip",
      windowMs: 60_000,
      max: 1,
      skip: (req) => req.path === "/health",
    });
    // Mount globally so /health flows through the limiter but is skipped.
    app.use(limiter);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    // /health is exempt no matter how many times it is hit.
    for (let i = 0; i < 5; i++) {
      await request(app).get("/health").expect(200);
    }

    // A counted route still throttles after max.
    await request(app).get("/ping").expect(200);
    await request(app).get("/ping").expect(429);
  });

  it("does not emit legacy or standard rate-limit headers", async () => {
    const app = makeApp(makeLimiter({ name: "headers", windowMs: 60_000, max: 5 }));
    const res = await request(app).get("/api/ping");

    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Retry-After header
  // ---------------------------------------------------------------------------

  it("sends a Retry-After header on every 429 response", async () => {
    const windowMs = 60_000;
    const app = makeApp(makeLimiter({ name: "retry-after", windowMs, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    const blocked = await request(app).get("/api/ping");

    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    // Value must be a positive integer string.
    const value = Number(blocked.headers["retry-after"]);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(1);
  });

  it("does not send Retry-After on allowed (non-429) responses", async () => {
    const app = makeApp(makeLimiter({ name: "no-retry-header", windowMs: 60_000, max: 5 }));
    const res = await request(app).get("/api/ping").expect(200);
    expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("sets Retry-After to the ceiling of windowMs / 1000", async () => {
    // windowMs = 90_000 ms → 90 s
    const windowMs = 90_000;
    const app = makeApp(makeLimiter({ name: "retry-after-value", windowMs, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    const blocked = await request(app).get("/api/ping").expect(429);

    expect(Number(blocked.headers["retry-after"])).toBe(90);
  });

  // ---------------------------------------------------------------------------
  // Observability: log on limit reached
  // ---------------------------------------------------------------------------

  it("logs a warning when the limit is reached", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = makeApp(makeLimiter({ name: "observable", windowMs: 60_000, max: 1 }));

    await request(app).get("/api/ping").expect(200);
    await request(app).get("/api/ping").expect(429);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('limiter="observable"'),
    );
  });

  it("does not log a warning on allowed requests", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = makeApp(makeLimiter({ name: "no-warn", windowMs: 60_000, max: 5 }));

    await request(app).get("/api/ping").expect(200);

    // The warn spy may have been called by keyByIp for an unresolved IP,
    // but must NOT have been called with the limit-reached message.
    const limitWarnings = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes("limit reached"),
    );
    expect(limitWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// keyByIp
// ---------------------------------------------------------------------------

describe("keyByIp", () => {
  it("returns req.ip when present", () => {
    expect(keyByIp({ ip: "203.0.113.7" } as express.Request)).toBe("203.0.113.7");
  });

  it("falls back to 'unknown' when the IP cannot be resolved", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = keyByIp({ ip: undefined } as unknown as express.Request);
    expect(key).toBe("unknown");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("req.ip is undefined"));
  });

  it("emits a warn when IP is undefined so operators notice misconfigured proxy", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    keyByIp({ ip: undefined } as unknown as express.Request);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("does not warn when IP is present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    keyByIp({ ip: "1.2.3.4" } as express.Request);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keys distinct client IPs separately (no cross-IP throttling)", async () => {
    const app = makeApp(makeLimiter({ name: "per-ip", windowMs: 60_000, max: 1 }));

    // Client A exhausts its single request.
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.1").expect(200);
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.1").expect(429);

    // Client B (different forwarded IP) is unaffected.
    await request(app).get("/api/ping").set("X-Forwarded-For", "198.51.100.2").expect(200);
  });
});

// ---------------------------------------------------------------------------
// retryAfterSeconds
// ---------------------------------------------------------------------------

describe("retryAfterSeconds", () => {
  it("converts milliseconds to whole seconds (ceiling)", () => {
    expect(retryAfterSeconds(60_000)).toBe(60);
    expect(retryAfterSeconds(90_000)).toBe(90);
    expect(retryAfterSeconds(1_500)).toBe(2); // 1.5 s → ceiling → 2
  });

  it("returns at least 1 for very short windows", () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(500)).toBe(1); // 0.5 s → ceiling → 1
    expect(retryAfterSeconds(1)).toBe(1);   // sub-ms → ceiling → 1
  });

  it("handles standard window values correctly", () => {
    expect(retryAfterSeconds(15 * 60 * 1000)).toBe(900);  // 15 min
    expect(retryAfterSeconds(5 * 60 * 1000)).toBe(300);   // 5 min
    expect(retryAfterSeconds(60 * 60 * 1000)).toBe(3600); // 1 hour
  });
});
