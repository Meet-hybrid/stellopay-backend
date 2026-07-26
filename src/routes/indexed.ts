import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc } from "drizzle-orm";
import { StarknetAddress, AgreementId, parsePagination } from "../utils/validation.js";
import { notFoundResponse } from "./not-found.js";

export const indexedRouter = Router();

/**
 * Hard limit for sub-resources (events, payments, etc.) inside a detail view
 * to prevent unbounded database scans.
 */
const MAX_INTERNAL_LIMIT = 200;

// Output Schemas for Contract Hardening
const AgreementSchema = z.object({
  id: z.string(),
  contractAddress: z.string(),
  employer: z.string(),
  contributor: z.string(),
  mode: z.number(),
  createdAt: z.date().or(z.string()),
}).passthrough();

const PaginatedResponse = (dataSchema: z.ZodTypeAny) => z.object({
  count: z.number().nonnegative(),
  source: z.string().optional(),
}).catchall(z.any());

// GET all agreements for a user
indexedRouter.get(
  "/indexed/agreements/:contract_address/user/:user_address",
  async (req, res, next) => {
    try {
      const contractAddress = StarknetAddress.parse(req.params.contract_address);
      if (contractAddress !== normalizeAddr(defaults.workAgreementAddress)) {
        res.status(400).json({ error: "Invalid contract address for agreements" });
        return;
      }
      const userAddress = StarknetAddress.parse(req.params.user_address);
      const { limit, offset } = parsePagination(req.query);

      // Find agreements where user is employer or contributor, and separately
      // check if the user is an employee in any payroll agreements. These two
      // queries don't depend on each other, so run them concurrently instead
      // of paying for two sequential round trips.
      const [agreements, employeeAgreements] = await Promise.all([
        db
          .select()
          .from(schema.agreements)
          .where(
            and(
              eq(schema.agreements.contractAddress, contractAddress),
              or(
                eq(schema.agreements.employer, userAddress),
                eq(schema.agreements.contributor, userAddress),
              ),
            ),
          )
          .orderBy(desc(schema.agreements.createdAt))
          .limit(limit)
          .offset(offset),

        db
          .select({
            agreement: schema.agreements,
          })
          .from(schema.agreements)
          .innerJoin(schema.employees, eq(schema.agreements.id, schema.employees.agreementId))
          .where(
            and(
              eq(schema.agreements.contractAddress, contractAddress),
              eq(schema.employees.employeeAddress, userAddress),
              eq(schema.agreements.mode, 1), // Payroll mode
            ),
          )
          .orderBy(desc(schema.agreements.createdAt))
          .limit(limit),
      ]);

      const allAgreements = [...agreements, ...employeeAgreements.map((e) => e.agreement)];
      const uniqueAgreements = Array.from(
        new Map(allAgreements.map((a) => [a.id, a])).values(),
      ).slice(0, limit);

      res.json({
        agreements: z.array(AgreementSchema).parse(uniqueAgreements),
        count: uniqueAgreements.length,
        source: "indexed",
      });
    } catch (e) {
      next(e);
    }
  },
);

// GET agreement details by ID (Hardened Sub-resource limits)
indexedRouter.get("/indexed/agreement/:contract_address/:agreement_id", async (req, res, next) => {
  try {
    const contractAddress = StarknetAddress.parse(req.params.contract_address);
    if (contractAddress !== normalizeAddr(defaults.workAgreementAddress)) {
      res.status(400).json({ error: "Invalid contract address for agreement details" });
      return;
    }
    const agreementId = AgreementId.parse(req.params.agreement_id);

    const agreement = await db
      .select()
      .from(schema.agreements)
      .where(
        and(
          eq(schema.agreements.contractAddress, contractAddress),
          eq(schema.agreements.id, agreementId),
        ),
      )
      .limit(1);

    if (agreement.length === 0) {
      notFoundResponse(res, "Agreement not found");
      return;
    }

    // HARDENING: We now apply .limit() to all related queries to prevent unbounded result sets
    const [events, payments, milestones, employees, escrowEvents] = await Promise.all([
      db.select().from(schema.agreementEvents)
        .where(eq(schema.agreementEvents.agreementId, agreementId))
        .orderBy(desc(schema.agreementEvents.blockNumber)).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.payments)
        .where(eq(schema.payments.agreementId, agreementId))
        .orderBy(desc(schema.payments.blockNumber)).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.milestones)
        .where(eq(schema.milestones.agreementId, agreementId))
        .orderBy(schema.milestones.milestoneId).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.employees)
        .where(eq(schema.employees.agreementId, agreementId))
        .orderBy(schema.employees.employeeIndex).limit(MAX_INTERNAL_LIMIT),

      db.select().from(schema.escrowEvents)
        .where(eq(schema.escrowEvents.agreementId, agreementId))
        .orderBy(desc(schema.escrowEvents.blockNumber)).limit(MAX_INTERNAL_LIMIT),
    ]);

    res.json({
      agreement: AgreementSchema.parse(agreement[0]),
      events,
      payments,
      milestones,
      employees,
      escrowEvents,
    });
  } catch (e) {
    next(e);
  }
});

// GET payments for a user
indexedRouter.get("/indexed/payments/user/:user_address", async (req, res, next) => {
  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const { limit, offset } = parsePagination(req.query);

    const payments = await db
      .select()
      .from(schema.payments)
      .where(or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)))
      .orderBy(desc(schema.payments.blockNumber))
      .limit(limit)
      .offset(offset);

    res.json({ payments, count: payments.length });
  } catch (e) {
    next(e);
  }
});

// GET escrow balance (Hardened event processing)
indexedRouter.get(
  "/indexed/escrow/:contract_address/balance/:agreement_id",
  async (req, res, next) => {
    try {
      const contractAddress = StarknetAddress.parse(req.params.contract_address);
      if (contractAddress !== normalizeAddr(defaults.payrollEscrowAddress)) {
        res.status(400).json({ error: "Invalid contract address for escrow balance" });
        return;
      }
      const agreementId = AgreementId.parse(req.params.agreement_id);

      // We bound this query to 500 events; calculating balance for more than 500 
      // events in a single HTTP request is a performance risk.
      const escrowEvents = await db
        .select()
        .from(schema.escrowEvents)
        .where(
          and(
            eq(schema.escrowEvents.contractAddress, contractAddress),
            eq(schema.escrowEvents.agreementId, agreementId),
          ),
        )
        .orderBy(schema.escrowEvents.blockNumber)
        .limit(500); 

      let balance = BigInt(0);
      for (const event of escrowEvents) {
        if (event.eventType === "Funded") {
          balance += BigInt(event.amount);
        } else if (event.eventType === "Released" || event.eventType === "Refunded") {
          balance -= BigInt(event.amount);
        }
      }

      res.json({
        agreement_id: agreementId,
        balance: balance.toString(),
        events: escrowEvents,
      });
    } catch (e) {
      next(e);
    }
  },
);