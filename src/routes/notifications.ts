import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc, inArray } from "drizzle-orm";
import { StarknetAddress } from "../utils/validation.js";
import { formatTokenAmount, getTokenInfo } from "../utils/token-formatting.js";

export const notificationsRouter = Router();

/**
 * 1. CONTRACT DEFINITIONS
 * We define strict schemas so the runtime, tests, and docs all share the same source of truth.
 */
const NotificationPreferencesSchema = z.object({
  email: z.boolean().default(true),
  push: z.boolean().default(true),
  marketing: z.boolean().default(false),
}).strict(); // .strict() rejects unknown fields

const NotificationItemSchema = z.object({
  id: z.string().or(z.number()),
  title: z.string(),
  message: z.string(),
  read: z.boolean(),
  date: z.string().datetime(),
  type: z.string(),
  txHash: z.string(),
});

const UnreadCountSchema = z.object({
  count: z.number().int().nonnegative(),
});

// --- ROUTES ---

// GET notifications for a user
notificationsRouter.get("/notifications/:user_address", async (req, res, next) => {
  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);
    const limit =
      z.coerce.number().int().positive().max(50).optional().parse(req.query.limit) || 10;

    const payments = await db
      .select()
      .from(schema.payments)
      .where(or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)))
      .orderBy(desc(schema.payments.blockNumber))
      .limit(limit);

    const userAgreements = await db
      .select({ id: schema.agreements.id, token: schema.agreements.token })
      .from(schema.agreements)
      .where(
        or(
          eq(schema.agreements.employer, userAddress),
          eq(schema.agreements.contributor, userAddress),
        ),
      );

    const agreementIds = userAgreements.map((a) => a.id);
    const agreementTokensById = new Map(userAgreements.map((a) => [a.id, a.token]));

    const importantEvents =
      agreementIds.length > 0
        ? await db
            .select()
            .from(schema.agreementEvents)
            .where(
              and(
                inArray(schema.agreementEvents.agreementId, agreementIds),
                or(
                  eq(schema.agreementEvents.eventType, "DisputeRaised"),
                  eq(schema.agreementEvents.eventType, "DisputeResolved"),
                  eq(schema.agreementEvents.eventType, "AgreementActivated"),
                  eq(schema.agreementEvents.eventType, "AgreementCancelled"),
                  eq(schema.agreementEvents.eventType, "AgreementCreated"),
                ),
              ),
            )
            .orderBy(desc(schema.agreementEvents.blockNumber))
            .limit(limit)
        : [];

    const escrowEvents = await db
      .select()
      .from(schema.escrowEvents)
      .where(
        or(eq(schema.escrowEvents.employer, userAddress), eq(schema.escrowEvents.to, userAddress)),
      )
      .orderBy(desc(schema.escrowEvents.blockNumber))
      .limit(limit);

    const rawNotifications = [
      ...payments.map((p) => {
        const tokenInfo = getTokenInfo(p.token);
        const formattedAmount = formatTokenAmount(p.amount, tokenInfo.decimals);
        return {
          id: p.id,
          title: p.eventType === "PaymentSent" ? "Payment Sent" : "Payment Received",
          message: `#${p.transactionHash.slice(0, 10)} · ${p.eventType === "PaymentSent" ? "You sent" : "You received"} ${formattedAmount} tokens`,
          read: false,
          date: p.createdAt.toISOString(),
          type: p.eventType,
          txHash: p.transactionHash,
        };
      }),
      ...importantEvents.map((e) => ({
        id: e.id,
        title: e.eventType.replace(/([A-Z])/g, ' $1').trim(),
        message: e.eventType === "AgreementCreated"
            ? `Agreement #${e.agreementId} has been created`
            : `Agreement ${e.agreementId}: ${e.eventType}`,
        read: false,
        date: e.createdAt.toISOString(),
        type: e.eventType,
        txHash: e.transactionHash,
      })),
      ...escrowEvents.map((e) => {
        const tokenInfo = getTokenInfo(agreementTokensById.get(e.agreementId) ?? null);
        return {
          id: e.id,
          title: e.eventType === "Funded" ? "Agreement Funded" : `Funds ${e.eventType}`,
          message: `Agreement ${e.agreementId}: ${e.eventType} of ${formatTokenAmount(e.amount, tokenInfo.decimals)} tokens`,
          read: false,
          date: e.createdAt.toISOString(),
          type: e.eventType,
          txHash: e.transactionHash,
        };
      }),
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);

    // Hardening: Validate output against schema to ensure no malformed data leaves the route
    const validatedNotifications = z.array(NotificationItemSchema).parse(rawNotifications);

    res.json({ notifications: validatedNotifications, total: validatedNotifications.length });
  } catch (e) {
    next(e);
  }
});

// GET unread count
notificationsRouter.get("/notifications/:user_address/unread-count", async (req, res, next) => {
  try {
    const userAddress = StarknetAddress.parse(req.params.user_address);
    
    // In a real app, this would query a 'notifications' table with a 'read' status.
    // Based on the current code logic, we assume events are unread by default.
    const count = await db.$count(schema.payments, or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)));
    
    // Harden the response using the schema
    const response = UnreadCountSchema.parse({ count: Math.max(0, count) });
    res.json(response);
  } catch (e) {
    next(e);
  }
});

// PATCH notification preferences
notificationsRouter.patch("/notifications/:user_address/preferences", async (req, res, next) => {
  try {
    const _userAddress = StarknetAddress.parse(req.params.user_address);
    
    // Strict validation of the body
    const preferences = NotificationPreferencesSchema.parse(req.body);

    // Logic to save 'preferences' to the database would go here.
    // For now, we return the validated preferences to satisfy the contract.
    res.json({ success: true, preferences });
  } catch (e) {
    next(e);
  }
});
