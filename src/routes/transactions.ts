import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc, gte, lte, inArray, sql, count } from "drizzle-orm";
import { agreementContract } from "../starknet/client.js";
import { toHexString } from "../utils/codec.js";
import { normalizeStarknetAddress as normalizeAddr } from "../utils/address.js";
import { env } from "../config.js";
import { formatTokenAmount, getTokenInfo as resolveTokenInfo, type TokenInfo } from "../utils/token-formatting.js";

const AddressParam = z.string().min(3);

export const transactionsRouter = Router();

/** Structured metrics for transaction endpoint diagnostics. */
interface TxRequestMetrics {
  route: string;
  userAddress: string;
  durationMs: number;
  totalResults: number;
  paymentsCount: number;
  escrowCount: number;
  agreementEventsCount: number;
  employeeCount: number;
  milestoneCount: number;
  tokenFetchDurationMs: number;
  error?: string;
  correlationId: string;
}

function logTxMetrics(metrics: TxRequestMetrics): void {
  const level = metrics.error ? "error" : "info";
  console[level](
    `[transactions:metrics] ${JSON.stringify({
      ...metrics,
      timestamp: new Date().toISOString(),
    })}`,
  );
}

/**
 * Emits verbose token-matching and fetch diagnostics only when LOG_LEVEL is set
 * to "debug". These lines are noisy on the request hot path and can include
 * token addresses, so at the default "info" level, and in production, they stay
 * silent: this keeps sensitive routing data out of default-level logs and stops
 * the per-request flood that previously ran on every transaction list. Genuine
 * failures still use console.error and console.warn so errors stay visible.
 *
 * @param args - Values forwarded to console.debug when debug logging is on.
 */
function debugLog(...args: unknown[]): void {
  if (env.LOG_LEVEL === "debug") {
    console.debug(...args);
  }
}

// Helper to format address for display (truncate like 0x1234...5678)
function formatAddress(addr: string): string {
  if (!addr || addr === "N/A") return addr;
  const normalized = normalizeAddr(addr);
  if (normalized.length <= 10) return normalized;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

// Token addresses from environment variables (with defaults)
const STRK_TOKEN_ADDRESS =
  env.TOKEN_STRK || "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC_TOKEN_ADDRESS =
  env.TOKEN_USDC || "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080";
const USDT_TOKEN_ADDRESS =
  env.TOKEN_USDT || "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb";

// Normalize token addresses once at module load
const NORMALIZED_STRK = normalizeAddr(STRK_TOKEN_ADDRESS);
const NORMALIZED_USDC = normalizeAddr(USDC_TOKEN_ADDRESS);
const NORMALIZED_USDT = normalizeAddr(USDT_TOKEN_ADDRESS);

// Helper to get token info from token address
function getTokenInfo(tokenAddress: string | null | undefined): TokenInfo {
  if (!tokenAddress) {
    return { name: "-", icon: "", decimals: 0, isSTRK: false };
  }
  return resolveTokenInfo(tokenAddress);
}

// Helper to format amount based on token type
function formatAmount(amount: string | bigint, tokenInfo: TokenInfo): string {
  if (!amount || amount === "0" || amount === BigInt(0)) {
    return "-";
  }
  const formattedAmount = formatTokenAmount(amount, tokenInfo.decimals);
  if (tokenInfo.isSTRK) {
    const [wholePart, fractionalPart = ""] = formattedAmount.split(".");
    const fractionalDisplay = fractionalPart.slice(0, 6);
    return fractionalDisplay ? `${wholePart}.${fractionalDisplay} ${tokenInfo.name}` : `${wholePart} ${tokenInfo.name}`;
  }
  const [wholePart, fractionalPart = ""] = formattedAmount.split(".");
  const fractionalDisplay = fractionalPart.slice(0, 2).padEnd(2, "0");
  return `$${wholePart}${fractionalDisplay ? `.${fractionalDisplay}` : ".00"}`;
}

// Cache for token addresses
const tokenCache = new Map<string, { token: string; timestamp: number }>();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// Helper to fetch token from agreement contract
async function getTokenFromAgreementContract(
  agreementContractAddress: string,
  agreementId: string,
): Promise<string | null> {
  const cacheKey = `${agreementContractAddress}:${agreementId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }
  try {
    const c = agreementContract(agreementContractAddress);
    const out = await c.get_token(agreementId);
    const tokenAddress = toHexString(out);
    const normalizedToken = normalizeAddr(tokenAddress);
    tokenCache.set(cacheKey, { token: normalizedToken, timestamp: Date.now() });
    return normalizedToken;
  } catch (error: any) {
    console.error(`[transactions] Failed to fetch token for agreement ${agreementId}:`, error?.message);
    return null;
  }
}

// Batch fetch tokens
async function batchGetTokensFromAgreementContracts(
  agreements: Array<{ agreementContractAddress: string; agreementId: string }>,
): Promise<Map<string, string>> {
  const tokenMap = new Map<string, string>();
  const uncachedAgreements: Array<{ agreementContractAddress: string; agreementId: string; key: string }> = [];
  for (const agreement of agreements) {
    const cacheKey = `${agreement.agreementContractAddress}:${agreement.agreementId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL_MS) {
      tokenMap.set(agreement.agreementId, cached.token);
    } else {
      uncachedAgreements.push({ ...agreement, key: cacheKey });
    }
  }
  const BATCH_SIZE = 10;
  for (let i = 0; i < uncachedAgreements.length; i += BATCH_SIZE) {
    const batch = uncachedAgreements.slice(i, i + BATCH_SIZE);
    const fetchPromises = batch.map(async (agreement) => {
      try {
        const token = await getTokenFromAgreementContract(agreement.agreementContractAddress, agreement.agreementId);
        if (token) tokenMap.set(agreement.agreementId, token);
      } catch (error) {
        console.error(`[transactions] Batch fetch error for agreement ${agreement.agreementId}`);
      }
    });
    await Promise.all(fetchPromises);
  }
  return tokenMap;
}

// Format date helper
function formatDate(date: Date) {
  const d = new Date(date);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const mins = minutes.toString().padStart(2, "0");
  return { date: `${month} ${day}, ${year}`, time: `${hour12}:${mins}${ampm}` };
}

function formatEventType(eventType: string): string {
  const eventTypeMap: Record<string, string> = {
    AgreementCreated: "Agreement Created", AgreementActivated: "Agreement Activated",
    AgreementPaused: "Agreement Paused", AgreementResumed: "Agreement Resumed",
    AgreementCancelled: "Agreement Cancelled", AgreementCompleted: "Agreement Completed",
    PaymentSent: "Payment Sent", PaymentReceived: "Payment Received",
    MilestoneAdded: "Milestone Added", MilestoneApproved: "Milestone Approved",
    MilestoneClaimed: "Milestone Claimed", EmployeeAdded: "Employee Added",
    PayrollClaimed: "Payroll Claimed", DisputeRaised: "Dispute Raised",
    DisputeResolved: "Dispute Resolved", Funded: "Agreement Funded",
    Released: "Payment Released", Refunded: "Refund Received",
  };
  return eventTypeMap[eventType] || eventType.replace(/([A-Z])/g, " $1").trim();
}

// ── Main transactions endpoint ───────────────────────────────────────────

transactionsRouter.get("/transactions/:user_address", async (req, res, next) => {
  const correlationId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const startTime = Date.now();
  let tokenFetchDurationMs = 0;
  try {
    const userAddress = normalizeAddr(req.params.user_address);
    const requestedLimit = z.coerce.number().int().positive().optional().parse(req.query.limit) || 50;
    const limit = Math.min(requestedLimit, 100);
    const offset = z.coerce.number().int().nonnegative().optional().parse(req.query.offset) || 0;
    const queryLimit = offset + limit;

    const eventTypesFilter = req.query.eventTypes
      ? (req.query.eventTypes as string).split(",").map((t) => t.trim()).filter((t) => t.length > 0)
      : null;

    const paymentConditions = [or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress))];
    if (eventTypesFilter && eventTypesFilter.length > 0) {
      const paymentEventTypes = eventTypesFilter.filter((et) => et === "PaymentSent" || et === "PaymentReceived");
      if (paymentEventTypes.length > 0) paymentConditions.push(inArray(schema.payments.eventType, paymentEventTypes));
      else paymentConditions.push(sql`FALSE`);
    }

    const escrowConditions = [or(eq(schema.escrowEvents.employer, userAddress), eq(schema.escrowEvents.to, userAddress))];
    if (eventTypesFilter && eventTypesFilter.length > 0) {
      const escrowEventTypes = eventTypesFilter.filter((et) => et === "Funded" || et === "Released" || et === "Refunded");
      if (escrowEventTypes.length > 0) escrowConditions.push(inArray(schema.escrowEvents.eventType, escrowEventTypes));
      else escrowConditions.push(sql`FALSE`);
    }

    const agreementEventConditions = eventTypesFilter && eventTypesFilter.length > 0
      ? and(or(...eventTypesFilter.map((et) => eq(schema.agreementEvents.eventType, et))),
            or(eq(schema.agreements.employer, userAddress), eq(schema.agreements.contributor, userAddress)))
      : or(eq(schema.agreements.employer, userAddress), eq(schema.agreements.contributor, userAddress));

    const employeeConditions = [or(eq(schema.agreements.employer, userAddress), eq(schema.employees.employeeAddress, userAddress))];
    if (eventTypesFilter && eventTypesFilter.length > 0 && !eventTypesFilter.includes("EmployeeAdded")) {
      employeeConditions.push(sql`FALSE`);
    }

    const milestoneConditions = [or(eq(schema.agreements.employer, userAddress), eq(schema.agreements.contributor, userAddress))];
    if (eventTypesFilter && eventTypesFilter.length > 0 && !eventTypesFilter.includes("MilestoneAdded")) {
      milestoneConditions.push(sql`FALSE`);
    }

    const [paymentsCount, escrowCount, agreementEventsCount, employeesCount, milestonesCount] = await Promise.all([
      db.select({ count: count() }).from(schema.payments).where(and(...paymentConditions)),
      db.select({ count: count() }).from(schema.escrowEvents).where(and(...escrowConditions)),
      db.select({ count: count() }).from(schema.agreementEvents)
        .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
        .where(agreementEventConditions),
      db.select({ count: count() }).from(schema.employees)
        .leftJoin(schema.agreements, eq(schema.employees.agreementId, schema.agreements.id))
        .where(and(...employeeConditions)),
      db.select({ count: count() }).from(schema.milestones)
        .leftJoin(schema.agreements, eq(schema.milestones.agreementId, schema.agreements.id))
        .where(and(...milestoneConditions)),
    ]);

    const total = Number(paymentsCount[0].count) + Number(escrowCount[0].count) +
      Number(agreementEventsCount[0].count) + Number(employeesCount[0].count) + Number(milestonesCount[0].count);

    const [payments, escrowEvents, agreementEvents, employeeEventsData, milestoneEventsData] = await Promise.all([
      db.select().from(schema.payments).where(and(...paymentConditions))
        .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id)).limit(queryLimit),
      db.select().from(schema.escrowEvents).where(and(...escrowConditions))
        .orderBy(desc(schema.escrowEvents.createdAt), desc(schema.escrowEvents.id)).limit(queryLimit),
      db.select({
        id: schema.agreementEvents.id, agreementId: schema.agreementEvents.agreementId,
        contractAddress: schema.agreementEvents.contractAddress, eventType: schema.agreementEvents.eventType,
        blockNumber: schema.agreementEvents.blockNumber, transactionHash: schema.agreementEvents.transactionHash,
        createdAt: schema.agreementEvents.createdAt, employer: schema.agreements.employer,
        contributor: schema.agreements.contributor, token: schema.agreements.token,
      }).from(schema.agreementEvents)
        .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
        .where(agreementEventConditions)
        .orderBy(desc(schema.agreementEvents.createdAt), desc(schema.agreementEvents.id)).limit(queryLimit),
      db.select({
        id: schema.employees.id, agreementId: schema.employees.agreementId,
        contractAddress: schema.employees.contractAddress, blockNumber: schema.employees.blockNumber,
        transactionHash: schema.employees.transactionHash, createdAt: schema.employees.createdAt,
        employer: schema.agreements.employer, contributor: schema.agreements.contributor,
        token: schema.agreements.token, employeeAddress: schema.employees.employeeAddress,
        amount: schema.employees.salaryPerPeriod,
      }).from(schema.employees)
        .leftJoin(schema.agreements, eq(schema.employees.agreementId, schema.agreements.id))
        .where(and(...employeeConditions))
        .orderBy(desc(schema.employees.createdAt), desc(schema.employees.id)).limit(queryLimit),
      db.select({
        id: schema.milestones.id, agreementId: schema.milestones.agreementId,
        contractAddress: schema.milestones.contractAddress, blockNumber: schema.milestones.blockNumber,
        transactionHash: schema.milestones.transactionHash, createdAt: schema.milestones.createdAt,
        employer: schema.agreements.employer, contributor: schema.agreements.contributor,
        token: schema.agreements.token, amount: schema.milestones.amount,
      }).from(schema.milestones)
        .leftJoin(schema.agreements, eq(schema.milestones.agreementId, schema.agreements.id))
        .where(and(...milestoneConditions))
        .orderBy(desc(schema.milestones.createdAt), desc(schema.milestones.id)).limit(queryLimit),
    ]);

    const employeeEvents = employeeEventsData.map((e) => ({ ...e, eventType: "EmployeeAdded" as const }));
    const milestoneEvents = milestoneEventsData.map((m) => ({ ...m, eventType: "MilestoneAdded" as const }));
    const uniqueAgreementEvents = Array.from(new Map(agreementEvents.map((a) => [a.id, a])).values());

    const agreementIds = [...new Set(escrowEvents.map((e) => e.agreementId))];
    const agreements = agreementIds.length > 0
      ? await db.select({ id: schema.agreements.id, token: schema.agreements.token, contractAddress: schema.agreements.contractAddress })
          .from(schema.agreements).where(inArray(schema.agreements.id, agreementIds))
      : [];

    const tokenFetchStart = Date.now();
    const contractTokenMap = await batchGetTokensFromAgreementContracts(
      agreements.filter((a) => a.contractAddress).map((a) => ({ agreementContractAddress: a.contractAddress!, agreementId: a.id }))
    );
    tokenFetchDurationMs = Date.now() - tokenFetchStart;

    const tokenMap = new Map<string, string>();
    for (const agreement of agreements) {
      tokenMap.set(agreement.id, contractTokenMap.get(agreement.id) || agreement.token);
    }

    const allTransactions = [
      ...uniqueAgreementEvents.map((a) => {
        const dateTime = formatDate(a.createdAt);
        return {
          id: a.transactionHash.slice(0, 10), type: formatEventType(a.eventType),
          address: formatAddress(a.employer === userAddress ? a.contributor || "N/A" : a.employer),
          date: dateTime.date, time: dateTime.time, token: "-", amount: "-",
          status: "Completed" as const, tokenIcon: "", txHash: a.transactionHash, createdAt: a.createdAt,
        };
      }),
      ...payments.map((p) => {
        const dateTime = formatDate(p.createdAt);
        const tokenInfo = getTokenInfo(p.token);
        const amountStr = formatAmount(p.amount, tokenInfo);
        const isReceived = p.eventType === "PaymentReceived";
        const sign = isReceived ? "+" : "-";
        return {
          id: p.transactionHash.slice(0, 10),
          type: p.eventType === "PaymentSent" ? "Payment Sent" : "Payment Received",
          address: formatAddress(isReceived ? p.from : p.to),
          date: dateTime.date, time: dateTime.time, token: tokenInfo.name,
          amount: amountStr !== "-" ? `${sign}${amountStr}` : amountStr,
          status: "Completed" as const, tokenIcon: tokenInfo.icon, txHash: p.transactionHash, createdAt: p.createdAt,
        };
      }),
      ...escrowEvents.map((e) => {
        const dateTime = formatDate(e.createdAt);
        const tokenAddress = tokenMap.get(e.agreementId) || null;
        const tokenInfo = getTokenInfo(tokenAddress);
        const amountStr = formatAmount(e.amount, tokenInfo);
        const isIncoming = e.eventType === "Released" || e.eventType === "Refunded";
        const sign = isIncoming ? "+" : "-";
        return {
          id: e.transactionHash.slice(0, 10),
          type: e.eventType === "Funded" ? "Agreement Funded" : e.eventType === "Released" ? "Payment Released" : "Refund Received",
          address: formatAddress(e.eventType === "Funded" ? e.employer : e.to || ""),
          date: dateTime.date, time: dateTime.time, token: tokenInfo.name,
          amount: amountStr !== "-" ? `${sign}${amountStr}` : amountStr,
          status: "Completed" as const, tokenIcon: tokenInfo.icon, txHash: e.transactionHash, createdAt: e.createdAt,
        };
      }),
      ...employeeEvents.map((e) => {
        const dateTime = formatDate(e.createdAt);
        const address = e.employer === userAddress ? e.employeeAddress || "N/A" : e.employer || e.employeeAddress || "N/A";
        return {
          id: e.transactionHash.slice(0, 10), type: "Employee Added", address: formatAddress(address),
          date: dateTime.date, time: dateTime.time, token: "-", amount: "-",
          status: "Completed" as const, tokenIcon: "", txHash: e.transactionHash, createdAt: e.createdAt,
        };
      }),
      ...milestoneEvents.map((m) => {
        const dateTime = formatDate(m.createdAt);
        const address = m.employer === userAddress ? m.contributor || "N/A" : m.employer || "N/A";
        return {
          id: m.transactionHash.slice(0, 10), type: "Milestone Added", address: formatAddress(address),
          date: dateTime.date, time: dateTime.time, token: "-", amount: "-",
          status: "Completed" as const, tokenIcon: "", txHash: m.transactionHash, createdAt: m.createdAt,
        };
      }),
    ].sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.txHash.localeCompare(b.txHash);
    });

    const paginatedTransactions = allTransactions.slice(offset, offset + limit);
    const hasMore = total > offset + limit;

    const durationMs = Date.now() - startTime;
    logTxMetrics({
      route: req.path, userAddress: userAddress.slice(0, 12) + "...", durationMs,
      totalResults: total, paymentsCount: Number(paymentsCount[0].count),
      escrowCount: Number(escrowCount[0].count), agreementEventsCount: Number(agreementEventsCount[0].count),
      employeeCount: Number(employeesCount[0].count), milestoneCount: Number(milestonesCount[0].count),
      tokenFetchDurationMs, correlationId,
    });

    res.json({ transactions: paginatedTransactions, total, hasMore, limit, offset });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    logTxMetrics({
      route: req.path, userAddress: req.params?.user_address?.slice(0, 12) + "..." || "unknown",
      durationMs, totalResults: 0, paymentsCount: 0, escrowCount: 0,
      agreementEventsCount: 0, employeeCount: 0, milestoneCount: 0,
      tokenFetchDurationMs, correlationId,
      error: (e as Error).message,
    });
    next(e);
  }
});

// ── Filtered transactions endpoint ────────────────────────────────────────

transactionsRouter.get("/transactions/:user_address/filtered", async (req, res, next) => {
  const correlationId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const startTime = Date.now();
  let tokenFetchDurationMs = 0;
  try {
    const userAddress = normalizeAddr(req.params.user_address);
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
    const requestedLimit = z.coerce.number().int().positive().optional().parse(req.query.limit) || 50;
    const limit = Math.min(requestedLimit, 100);
    const offset = z.coerce.number().int().nonnegative().optional().parse(req.query.offset) || 0;
    const queryLimit = offset + limit;

    const paymentConditions = [or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress))];
    const escrowConditions = [or(eq(schema.escrowEvents.employer, userAddress), eq(schema.escrowEvents.to, userAddress))];
    const agreementEventConditions = [or(eq(schema.agreements.employer, userAddress), eq(schema.agreements.contributor, userAddress))];

    if (startDate) {
      paymentConditions.push(gte(schema.payments.createdAt, startDate));
      escrowConditions.push(gte(schema.escrowEvents.createdAt, startDate));
      agreementEventConditions.push(gte(schema.agreementEvents.createdAt, startDate));
    }
    if (endDate) {
      paymentConditions.push(lte(schema.payments.createdAt, endDate));
      escrowConditions.push(lte(schema.escrowEvents.createdAt, endDate));
      agreementEventConditions.push(lte(schema.agreementEvents.createdAt, endDate));
    }

    const employeeConditions = [eq(schema.employees.employeeAddress, userAddress)];
    const milestoneConditions = [or(eq(schema.agreements.employer, userAddress), eq(schema.agreements.contributor, userAddress))];
    if (startDate) { employeeConditions.push(gte(schema.employees.createdAt, startDate)); milestoneConditions.push(gte(schema.milestones.createdAt, startDate)); }
    if (endDate) { employeeConditions.push(lte(schema.employees.createdAt, endDate)); milestoneConditions.push(lte(schema.milestones.createdAt, endDate)); }

    const [paymentsCount, escrowCount, agreementEventsCount, employeesCount, milestonesCount] = await Promise.all([
      db.select({ count: count() }).from(schema.payments).where(and(...paymentConditions)),
      db.select({ count: count() }).from(schema.escrowEvents).where(and(...escrowConditions)),
      db.select({ count: count() }).from(schema.agreementEvents)
        .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
        .where(and(...agreementEventConditions)),
      db.select({ count: count() }).from(schema.employees)
        .leftJoin(schema.agreements, eq(schema.employees.agreementId, schema.agreements.id))
        .where(and(...employeeConditions)),
      db.select({ count: count() }).from(schema.milestones)
        .leftJoin(schema.agreements, eq(schema.milestones.agreementId, schema.agreements.id))
        .where(and(...milestoneConditions)),
    ]);

    const total = Number(paymentsCount[0].count) + Number(escrowCount[0].count) +
      Number(agreementEventsCount[0].count) + Number(employeesCount[0].count) + Number(milestonesCount[0].count);

    const [payments, escrowEvents, employeeEventsData, milestoneEventsData] = await Promise.all([
      db.select().from(schema.payments).where(and(...paymentConditions))
        .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id)).limit(queryLimit),
      db.select().from(schema.escrowEvents).where(and(...escrowConditions))
        .orderBy(desc(schema.escrowEvents.createdAt), desc(schema.escrowEvents.id)).limit(queryLimit),
      db.select({
        id: schema.employees.id, agreementId: schema.employees.agreementId,
        contractAddress: schema.employees.contractAddress, blockNumber: schema.employees.blockNumber,
        transactionHash: schema.employees.transactionHash, createdAt: schema.employees.createdAt,
        employer: schema.agreements.employer, contributor: schema.agreements.contributor,
        token: schema.agreements.token, employeeAddress: schema.employees.employeeAddress,
        amount: schema.employees.salaryPerPeriod,
      }).from(schema.employees)
        .leftJoin(schema.agreements, eq(schema.employees.agreementId, schema.agreements.id))
        .where(and(...employeeConditions))
        .orderBy(desc(schema.employees.createdAt), desc(schema.employees.id)).limit(queryLimit),
      db.select({
        id: schema.milestones.id, agreementId: schema.milestones.agreementId,
        contractAddress: schema.milestones.contractAddress, blockNumber: schema.milestones.blockNumber,
        transactionHash: schema.milestones.transactionHash, createdAt: schema.milestones.createdAt,
        employer: schema.agreements.employer, contributor: schema.agreements.contributor,
        token: schema.agreements.token, amount: schema.milestones.amount,
      }).from(schema.milestones)
        .leftJoin(schema.agreements, eq(schema.milestones.agreementId, schema.agreements.id))
        .where(and(...milestoneConditions))
        .orderBy(desc(schema.milestones.createdAt), desc(schema.milestones.id)).limit(queryLimit),
    ]);

    const employeeEvents = employeeEventsData.map((e) => ({ ...e, eventType: "EmployeeAdded" as const }));
    const milestoneEvents = milestoneEventsData.map((m) => ({ ...m, eventType: "MilestoneAdded" as const }));

    const escrowAgreementIds = [...new Set(escrowEvents.map((e) => e.agreementId))];
    const escrowAgreements = escrowAgreementIds.length > 0
      ? await db.select({ id: schema.agreements.id, token: schema.agreements.token, contractAddress: schema.agreements.contractAddress })
          .from(schema.agreements).where(inArray(schema.agreements.id, escrowAgreementIds))
      : [];

    const tokenFetchStart = Date.now();
    const contractTokenMap = await batchGetTokensFromAgreementContracts(
      escrowAgreements.filter((a) => a.contractAddress).map((a) => ({ agreementContractAddress: a.contractAddress!, agreementId: a.id }))
    );
    tokenFetchDurationMs = Date.now() - tokenFetchStart;

    const escrowTokenMap = new Map<string, string>();
    for (const agreement of escrowAgreements) {
      escrowTokenMap.set(agreement.id, contractTokenMap.get(agreement.id) || agreement.token);
    }

    const agreementEvents = await db.select({
      id: schema.agreementEvents.id, agreementId: schema.agreementEvents.agreementId,
      contractAddress: schema.agreementEvents.contractAddress, eventType: schema.agreementEvents.eventType,
      blockNumber: schema.agreementEvents.blockNumber, transactionHash: schema.agreementEvents.transactionHash,
      createdAt: schema.agreementEvents.createdAt, employer: schema.agreements.employer,
      contributor: schema.agreements.contributor, token: schema.agreements.token,
    }).from(schema.agreementEvents)
      .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
      .where(and(...agreementEventConditions))
      .orderBy(desc(schema.agreementEvents.createdAt), desc(schema.agreementEvents.id)).limit(queryLimit);

    const allTransactions = [
      ...agreementEvents.map((a) => {
        const dateTime = formatDate(a.createdAt);
        return {
          id: a.transactionHash.slice(0, 10), type: formatEventType(a.eventType),
          address: formatAddress(a.employer === userAddress ? a.contributor || "N/A" : a.employer),
          date: dateTime.date, time: dateTime.time, token: "-", amount: "-",
          status: "Completed" as const, tokenIcon: "", txHash: a.transactionHash, createdAt: a.createdAt,
        };
      }),
      ...payments.map((p) => {
        const dateTime = formatDate(p.createdAt);
        const tokenInfo = getTokenInfo(p.token);
        const amountStr = formatAmount(p.amount, tokenInfo);
        const isReceived = p.eventType === "PaymentReceived";
        const sign = isReceived ? "+" : "-";
        return {
          id: p.transactionHash.slice(0, 10),
          type: p.eventType === "PaymentSent" ? "Payment Sent" : "Payment Received",
          address: formatAddress(isReceived ? p.from : p.to),
          date: dateTime.date, time: dateTime.time, token: tokenInfo.name,
          amount: amountStr !== "-" ? `${sign}${amountStr}` : amountStr,
          status: "Completed" as const, tokenIcon: tokenInfo.icon, txHash: p.transactionHash, createdAt: p.createdAt,
        };
      }),
      ...escrowEvents.map((e) => {
        const dateTime = formatDate(e.createdAt);
        const tokenAddress = escrowTokenMap.get(e.agreementId) || null;
        const tokenInfo = getTokenInfo(tokenAddress);
        const amountStr = formatAmount(e.amount, tokenInfo);
        const isIncoming = e.eventType === "Released" || e.eventType === "Refunded";
        const sign = isIncoming ? "+" : "-";
        return {
          id: e.transactionHash.slice(0, 10),
          type: e.eventType === "Funded" ? "Agreement Funded" : e.eventType === "Released" ? "Payment Released" : "Refund Received",
          address: formatAddress(e.eventType === "Funded" ? e.employer : e.to || ""),
          date: dateTime.date, time: dateTime.time, token: tokenInfo.name,
          amount: amountStr !== "-" ? `${sign}${amountStr}` : amountStr,
          status: "Completed" as const, tokenIcon: tokenInfo.icon, txHash: e.transactionHash, createdAt: e.createdAt,
        };
      }),
      ...employeeEvents.map((e) => {
        const dateTime = formatDate(e.createdAt);
        const addressToFormat = e.employer === userAddress ? e.employeeAddress : e.employer;
        return {
          id: e.transactionHash.slice(0, 10), type: "Employee Added", address: formatAddress(addressToFormat || ""),
          date: dateTime.date, time: dateTime.time, token: "-", amount: "-",
          status: "Completed" as const, tokenIcon: "", txHash: e.transactionHash, createdAt: e.createdAt,
        };
      }),
      ...milestoneEvents.map((m) => {
        const dateTime = formatDate(m.createdAt);
        const addressToFormat = m.employer === userAddress ? m.contributor || "N/A" : m.employer;
        return {
          id: m.transactionHash.slice(0, 10), type: "Milestone Added", address: formatAddress(addressToFormat || ""),
          date: dateTime.date, time: dateTime.time, token: "-", amount: "-",
          status: "Completed" as const, tokenIcon: "", txHash: m.transactionHash, createdAt: m.createdAt,
        };
      }),
    ].sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.txHash.localeCompare(b.txHash);
    });

    const paginatedTransactions = allTransactions.slice(offset, offset + limit);
    const hasMore = total > offset + limit;

    const durationMs = Date.now() - startTime;
    logTxMetrics({
      route: req.path, userAddress: userAddress.slice(0, 12) + "...", durationMs,
      totalResults: total, paymentsCount: Number(paymentsCount[0].count),
      escrowCount: Number(escrowCount[0].count), agreementEventsCount: Number(agreementEventsCount[0].count),
      employeeCount: Number(employeesCount[0].count), milestoneCount: Number(milestonesCount[0].count),
      tokenFetchDurationMs, correlationId,
    });

    res.json({ transactions: paginatedTransactions, total, hasMore, limit, offset });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    logTxMetrics({
      route: req.path, userAddress: req.params?.user_address?.slice(0, 12) + "..." || "unknown",
      durationMs, totalResults: 0, paymentsCount: 0, escrowCount: 0,
      agreementEventsCount: 0, employeeCount: 0, milestoneCount: 0,
      tokenFetchDurationMs, correlationId,
      error: (e as Error).message,
    });
    next(e);
  }
});
