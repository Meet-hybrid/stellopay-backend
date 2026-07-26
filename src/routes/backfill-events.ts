import { Router } from "express";
import { requireAuth, requireAdmin } from "../auth/middleware.js";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, sql } from "drizzle-orm";
// Assuming a standard logger exists in the project. 
// If not, we fall back to a structured console object.
import { logger } from "../utils/logger.js"; 

export const backfillEventsRouter = Router();

const MAX_BACKFILL_LIMIT = 5000;

/**
 * Hardened Schema with Resume Token and Replay Window support.
 */
const BackfillQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_BACKFILL_LIMIT).optional().default(1000),
  agreementId: z.string().optional(),
  // resumeToken is the 'created_at' ISO string of the last processed record
  resumeToken: z.string().datetime().optional(), 
});

/**
 * Shared logic for backfilling events with telemetry
 */
async function performBackfill(
  type: "EmployeeAdded" | "MilestoneAdded",
  params: z.infer<typeof BackfillQuerySchema>
) {
  const startTime = performance.now();
  const { limit, agreementId, resumeToken } = params;

  logger.info({ 
    op: "backfill_start", 
    eventType: type, 
    limit, 
    agreementId, 
    resumeToken 
  }, `Starting ${type} backfill`);

  const tableName = type === "EmployeeAdded" ? "employees" : "milestones";
  const tableAlias = type === "EmployeeAdded" ? "e" : "m";
  
  const conditions = sql`1=1`;
  if (agreementId) conditions.append(sql` AND ${sql.identifier(tableAlias)}.agreement_id = ${agreementId}`);
  if (resumeToken) conditions.append(sql` AND ${sql.identifier(tableAlias)}.created_at < ${resumeToken}`);

  const query = sql`
    SELECT id, agreement_id, contract_address, block_number, transaction_hash, created_at
    FROM ${sql.identifier(tableName)} ${sql.identifier(tableAlias)}
    WHERE NOT EXISTS (
      SELECT 1 FROM agreement_events ae
      WHERE ae.agreement_id = ${sql.identifier(tableAlias)}.agreement_id
      AND ae.event_type = ${type}
      AND ae.transaction_hash = ${sql.identifier(tableAlias)}.transaction_hash
    )
    AND ${conditions}
    ORDER BY ${sql.identifier(tableAlias)}.created_at DESC
    LIMIT ${limit}
  `;

  const pendingRecords = await db.execute(query);
  const totalScanned = pendingRecords.rows.length;
  let created = 0;
  
  // Replay window boundaries
  const windowStart = totalScanned > 0 ? pendingRecords.rows[0].created_at : null;
  const windowEnd = totalScanned > 0 ? pendingRecords.rows[totalScanned - 1].created_at : null;

  await db.transaction(async (tx) => {
    for (const record of pendingRecords.rows) {
      const eventId = `${record.transaction_hash}_backfill_${type}_${record.id}`;
      await tx
        .insert(schema.agreementEvents)
        .values({
          id: eventId,
          agreementId: String(record.agreement_id),
          contractAddress: String(record.contract_address),
          eventType: type,
          blockNumber: Number(record.block_number),
          transactionHash: String(record.transaction_hash),
          eventIndex: -1,
        })
        .onConflictDoNothing();
      created++;
    }
  });

  const durationMs = performance.now() - startTime;
  
  logger.info({
    op: "backfill_complete",
    eventType: type,
    created,
    totalScanned,
    durationMs,
    windowStart,
    windowEnd, // This serves as the next resumeToken
  }, `Completed ${type} backfill`);

  return {
    message: `Backfilled ${created} ${type} events`,
    totalScanned,
    created,
    durationMs: Math.round(durationMs),
    nextResumeToken: windowEnd,
  };
}

backfillEventsRouter.post("/backfill/employee-events", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const params = BackfillQuerySchema.parse(req.query);
    const result = await performBackfill("EmployeeAdded", params);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid parameters", details: err.issues });
    next(e);
  }
});

backfillEventsRouter.post("/backfill/milestone-events", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const params = BackfillQuerySchema.parse(req.query);
    const result = await performBackfill("MilestoneAdded", params);
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: "Invalid parameters", details: err.issues });
    next(e);
  }
});
