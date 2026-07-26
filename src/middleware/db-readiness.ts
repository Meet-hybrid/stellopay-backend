import type { NextFunction, Request, Response } from "express";
import { env } from "../config.js";

/** When false, non-health API traffic receives 503 until startup confirms DB readiness. */
let applicationReady = env.NODE_ENV === "test";

/**
 * Marks whether the application may serve full API traffic (database confirmed ready).
 */
export function setApplicationReady(ready: boolean): void {
  applicationReady = ready;
}

export function isApplicationReady(): boolean {
  return applicationReady;
}

const READINESS_EXEMPT_PATHS = new Set(["/health", "/ready"]);

/**
 * Blocks non-health traffic with 503 until {@link setApplicationReady} is true.
 */
export function dbReadinessMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (READINESS_EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  if (!applicationReady) {
    res.status(503).json({
      error: "Service unavailable",
      message: "Database is not ready",
    });
    return;
  }

  next();
}
