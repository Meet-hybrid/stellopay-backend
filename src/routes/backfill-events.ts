import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";

export const backfillEventsRouter = Router();

// ---------------------------------------------------------------------------
// Contract constants – exported so tests and docs reference the single source
// of truth rather than duplicating magic numbers.
// ---------------------------------------------------------------------------

/** Maximum number of rows the backfill may scan per request. */
export const MAX_BACKFILL_LIMIT = 5000;

/** Default scan limit when the caller omits the `limit` query parameter. */
export const DEFAULT_BACKFILL_LIMIT = 1000;

/**
 * Sentinel `eventIndex` value written for every synthetic backfill row.
 * The `_backfill_` segment in the synthetic event ID already distinguishes
 * backfill rows from real on-chain events, so eventIndex is set to 0 to
 * satisfy the DB CHECK constraint (`event_index >= 0`).
 */
export const BACKFILL_EVENT_INDEX = 0;

/** How many result objects the response preview (`results` array) may contain. */
export const RESULTS_PREVIEW_SIZE = 10;

// ---------------------------------------------------------------------------
// Synthetic event-ID builder
// ---------------------------------------------------------------------------

/**
 * Build the deterministic, collision-safe event ID used for backfill rows.
 *
 * Format: `{transactionHash}_backfill_{eventType}_{rowId}`
 *
 * The `_backfill_` segment can never appear in real event IDs (which use
 * `{txHash}_{eventIndex}`), guaranteeing no collision.
 */
export function buildBackfillEventId(
  transactionHash: string,
  eventType: string,
  rowId: string,
): string {
  return `${transactionHash}_backfill_${eventType}_${rowId}`;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Zod schema for backfill query parameters.
 *
 * @property limit - Maximum number of rows to scan (1–5000, default 1000).
 * @property agreementId - Optional filter to only backfill events for a specific agreement.
 */
export const BackfillQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_BACKFILL_LIMIT).optional().default(DEFAULT_BACKFILL_LIMIT),
  agreementId: z.string().optional(),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** A single entry inside the response `results` array. */
export interface BackfillResultEntry {
  employeeId?: string;
  milestoneId?: string;
  agreementId: string;
  status: string;
  error?: string;
}

/** Shape returned by both backfill endpoints on success. */
export interface BackfillResponse {
  message: string;
  totalScanned: number;
  created: number;
  results: BackfillResultEntry[];
  cursor: string | null;
}

/**
 * POST /backfill/employee-events
 *
 * Backfill `EmployeeAdded` events for employees that don't yet have a
 * corresponding event in `agreement_events`.
 *
 * **Authentication:** Requires an active admin session (`requireAuth` +
 * `requireAdmin`).
 *
 * **Validation:** Query params are validated via {@link BackfillQuerySchema}.
 * - `limit` (optional, default 1000, max 5000) — number of candidate rows to scan.
 * - `agreementId` (optional) — restrict backfill to a single agreement.
 *
 * **Idempotency:** Synthetic event IDs use the form
 * `{transactionHash}_backfill_EmployeeAdded_{employeeId}` which cannot collide
 * with real event IDs (`{txHash}_{eventIndex}`).  The `_backfill_` segment in
 * the synthetic ID distinguishes backfill rows from real on-chain events.
 * The full insert loop runs inside a single database transaction; on conflict
 * the row is silently skipped (`onConflictDoNothing`).
 *
 * **Cursor-based resumption:** Pass a `cursor` query parameter (ISO date
 * string) to resume a large backfill. Only rows with `created_at` older than
 * the cursor are scanned.
 *
 * **Response** returns the total number of employees scanned, how many events
 * were created, a sample of the first 10 results, and a `cursor` for
 * resuming the next page (or `null` when all rows have been processed).
 */
backfillEventsRouter.post(
  "/backfill/employee-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { limit, agreementId, cursor } = BackfillQuerySchema.parse(req.query);

      const conditions = sql`1=1`;
      if (agreementId) {
        conditions.append(sql` AND e.agreement_id = ${agreementId}`);
      }
      if (cursor) {
        conditions.append(sql` AND e.created_at < ${cursor}`);
      }

      const employeesWithoutEvents = await db.execute(sql`
        SELECT e.id, e.agreement_id, e.contract_address, e.block_number,
               e.transaction_hash, e.created_at
        FROM employees e
        WHERE NOT EXISTS (
          SELECT 1 FROM agreement_events ae
          WHERE ae.agreement_id = e.agreement_id
          AND ae.event_type = 'EmployeeAdded'
          AND ae.transaction_hash = e.transaction_hash
        )
        AND ${conditions}
        ORDER BY e.created_at DESC
        LIMIT ${limit}
      `);

      let created = 0;
      const results: BackfillResultEntry[] = [];

      await db.transaction(async (tx) => {
        for (const employee of employeesWithoutEvents.rows) {
          const eventId = buildBackfillEventId(
            String(employee.transaction_hash),
            "EmployeeAdded",
            String(employee.id),
          );

          const inserted = await tx
            .insert(schema.agreementEvents)
            .values({
              id: eventId,
              agreementId: String(employee.agreement_id),
              contractAddress: String(employee.contract_address),
              eventType: "EmployeeAdded",
              blockNumber: Number(employee.block_number),
              transactionHash: String(employee.transaction_hash),
              eventIndex: BACKFILL_EVENT_INDEX,
            })
            .onConflictDoNothing()
            .returning();

          if (inserted.length > 0) {
            created++;
          }
          results.push({
            employeeId: String(employee.id),
            agreementId: String(employee.agreement_id),
            status: inserted.length > 0 ? "created" : "skipped",
          });
        }
      });

      const lastRow = employeesWithoutEvents.rows[employeesWithoutEvents.rows.length - 1];
      const body: BackfillResponse = {
        message: `Backfilled ${created} EmployeeAdded events`,
        totalScanned: employeesWithoutEvents.rows.length,
        created,
        results: results.slice(0, RESULTS_PREVIEW_SIZE),
        cursor: lastRow ? new Date(lastRow.created_at).toISOString() : null,
      };
      res.json(body);
    } catch (e: any) {
      if (e instanceof z.ZodError || e?.name === "ZodError") {
        res.status(400).json({ error: e.errors?.[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);

/**
 * POST /backfill/milestone-events
 *
 * Backfill `MilestoneAdded` events for milestones that don't yet have a
 * corresponding event in `agreement_events`.
 *
 * **Authentication:** Requires an active admin session (`requireAuth` +
 * `requireAdmin`).
 *
 * **Validation:** Query params are validated via {@link BackfillQuerySchema}.
 * - `limit` (optional, default 1000, max 5000) — number of candidate rows to scan.
 * - `agreementId` (optional) — restrict backfill to a single agreement.
 *
 * **Idempotency:** Identical approach to the employee-events sibling — synthetic
 * IDs with a `_backfill_MilestoneAdded_` segment and `onConflictDoNothing`
 * inside a transaction.  Re-runs are safe no-ops.
 *
 * **Cursor-based resumption:** Pass a `cursor` query parameter (ISO date
 * string) to resume a large backfill. Only rows with `created_at` older than
 * the cursor are scanned.
 *
 * **Response** returns the total number of milestones scanned, how many events
 * were created, a sample of the first 10 results, and a `cursor` for
 * resuming the next page (or `null` when all rows have been processed).
 */
backfillEventsRouter.post(
  "/backfill/milestone-events",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { limit, agreementId, cursor } = BackfillQuerySchema.parse(req.query);

      const conditions = sql`1=1`;
      if (agreementId) {
        conditions.append(sql` AND m.agreement_id = ${agreementId}`);
      }
      if (cursor) {
        conditions.append(sql` AND m.created_at < ${cursor}`);
      }

      const milestonesWithoutEvents = await db.execute(sql`
        SELECT m.id, m.agreement_id, m.contract_address, m.block_number,
               m.transaction_hash, m.created_at
        FROM milestones m
        WHERE NOT EXISTS (
          SELECT 1 FROM agreement_events ae
          WHERE ae.agreement_id = m.agreement_id
          AND ae.event_type = 'MilestoneAdded'
          AND ae.transaction_hash = m.transaction_hash
        )
        AND ${conditions}
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `);

      let created = 0;
      const results: BackfillResultEntry[] = [];

      await db.transaction(async (tx) => {
        for (const milestone of milestonesWithoutEvents.rows) {
          const eventId = buildBackfillEventId(
            String(milestone.transaction_hash),
            "MilestoneAdded",
            String(milestone.id),
          );

          const inserted = await tx
            .insert(schema.agreementEvents)
            .values({
              id: eventId,
              agreementId: String(milestone.agreement_id),
              contractAddress: String(milestone.contract_address),
              eventType: "MilestoneAdded",
              blockNumber: Number(milestone.block_number),
              transactionHash: String(milestone.transaction_hash),
              eventIndex: BACKFILL_EVENT_INDEX,
            })
            .onConflictDoNothing()
            .returning();

          if (inserted.length > 0) {
            created++;
          }
          results.push({
            milestoneId: String(milestone.id),
            agreementId: String(milestone.agreement_id),
            status: inserted.length > 0 ? "created" : "skipped",
          });
        }
      });

      const lastRow = milestonesWithoutEvents.rows[milestonesWithoutEvents.rows.length - 1];
      const body: BackfillResponse = {
        message: `Backfilled ${created} MilestoneAdded events`,
        totalScanned: milestonesWithoutEvents.rows.length,
        created,
        results: results.slice(0, RESULTS_PREVIEW_SIZE),
        cursor: lastRow ? new Date(lastRow.created_at).toISOString() : null,
      };
      res.json(body);
    } catch (e: any) {
      if (e instanceof z.ZodError || e?.name === "ZodError") {
        res.status(400).json({ error: e.errors?.[0]?.message || "Invalid request parameters" });
        return;
      }
      next(e);
    }
  },
);
