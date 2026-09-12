import { Prisma, PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { lockPurchaseWalletTransition } from '../../providers/purchase-wallet-funding-repo';
import { canonicalStoredPurchaseFingerprint } from './fingerprint';
import { PurchaseError } from './errors';
import { lockPurchaseAgentAdmission, type PurchaseAgentAdmission } from './repoAgentAdmission';

const FINGERPRINT_BACKFILL_LOCK_SEED = 8_675_309;
const IDEMPOTENT_PURCHASE_STATUSES = [
  PurchaseSpendStatus.PENDING_APPROVAL,
  PurchaseSpendStatus.CHARGING,
  PurchaseSpendStatus.FUNDING_PENDING,
  PurchaseSpendStatus.FUNDING_ABANDONED,
  PurchaseSpendStatus.HELD,
  PurchaseSpendStatus.CAPTURE_FAILED,
  PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
  PurchaseSpendStatus.REFUND_FAILED,
];

export { createPendingPurchaseWithLock } from './repoOpen';
export { assertPurchaseAgentAdmitted } from './repoAgentAdmission';

function legacyFingerprintWhere(
  userId: string,
  since: Date,
  before: Date
): Prisma.PurchaseSpendWhereInput {
  return {
    userId,
    status: { in: IDEMPOTENT_PURCHASE_STATUSES },
    canonicalFingerprint: null,
    createdAt: { gte: since, lt: before },
  };
}

export async function findMostRecentPurchaseByUserAndFingerprint(
  userId: string,
  fingerprint: string,
  agentId?: string
) {
  // When scoped to an agent, still surface legacy null-agent rows so in-flight / HELD carts
  // keep the double-charge guard. Other agents' rows stay excluded.
  const scopedAgentId = agentId !== undefined && agentId.trim() !== '' ? agentId.trim() : undefined;
  return prisma.purchaseSpend.findFirst({
    where: {
      userId,
      AND: [
        { OR: [{ fingerprint }, { canonicalFingerprint: fingerprint }] },
        ...(scopedAgentId !== undefined
          ? [{ OR: [{ agentId: scopedAgentId }, { agentId: null }] }]
          : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findPurchaseById(id: string) {
  return prisma.purchaseSpend.findUnique({ where: { id } });
}

export async function findRecentPurchaseByUserAndFingerprint(
  userId: string,
  fingerprint: string,
  since: Date
) {
  return prisma.purchaseSpend.findFirst({
    where: {
      userId,
      OR: [{ fingerprint }, { canonicalFingerprint: fingerprint }],
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function backfillLegacyCanonicalFingerprints(
  userId: string,
  since: Date,
  before: Date
) {
  const where = legacyFingerprintWhere(userId, since, before);
  const remaining = await prisma.purchaseSpend.findFirst({ where, select: { id: true } });
  if (remaining === null) return 0;

  return prisma.$transaction(
    async (transaction) => {
      // Serialize the one-time migration per user. Concurrent first misses wait here, then see no
      // remaining null rows instead of independently materializing and updating the same receipts.
      await transaction.$queryRaw`
        WITH acquired AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(
            hashtextextended(${userId}, ${FINGERPRINT_BACKFILL_LOCK_SEED})
          )
        )
        SELECT 1 AS locked FROM acquired
      `;
      const candidates = await transaction.purchaseSpend.findMany({
        where,
        orderBy: { createdAt: 'asc' },
      });
      const entries = candidates.flatMap((candidate) => {
        const canonicalFingerprint = canonicalStoredPurchaseFingerprint({
          userId,
          merchant: candidate.merchant,
          lineItemsJson: candidate.lineItemsJson,
          totalCents: candidate.totalCents,
        });
        return canonicalFingerprint === null ? [] : [{ id: candidate.id, canonicalFingerprint }];
      });
      if (entries.length === 0) return 0;

      const valueRows = entries.map(
        (entry) => Prisma.sql`(${entry.id}, ${entry.canonicalFingerprint})`
      );
      return transaction.$executeRaw(Prisma.sql`
        UPDATE "PurchaseSpend" AS purchase
        SET "canonicalFingerprint" = candidate."canonicalFingerprint"
        FROM (VALUES ${Prisma.join(valueRows)}) AS candidate("id", "canonicalFingerprint")
        WHERE purchase.id = candidate.id
          AND purchase."canonicalFingerprint" IS NULL
      `);
    },
    { maxWait: 30_000, timeout: 30_000 }
  );
}

export async function createPendingPurchase(data: {
  userId: string;
  agentId?: string;
  fingerprint: string;
  canonicalFingerprint: string;
  merchant: string;
  lineItemsJson: unknown;
  totalCents: number;
}) {
  return runTransactionWithRetry(async (tx) => {
    const agentId = await lockPurchaseAgentAdmission(tx, data);
    return tx.purchaseSpend.create({
      data: {
        userId: data.userId,
        agentId,
        fingerprint: data.fingerprint,
        canonicalFingerprint: data.canonicalFingerprint,
        merchant: data.merchant,
        lineItemsJson: data.lineItemsJson as Prisma.InputJsonValue,
        totalCents: data.totalCents,
        status: PurchaseSpendStatus.PENDING_APPROVAL,
      },
    });
  });
}

export async function updatePurchaseStatus(
  id: string,
  status: PurchaseSpendStatus,
  extra: {
    cardId?: string | null;
    stripePaymentIntentId?: string | null;
    lineItemsJson?: unknown;
  } = {}
) {
  const { lineItemsJson, ...rest } = extra;
  return prisma.purchaseSpend.update({
    where: { id },
    data: {
      status,
      ...rest,
      ...(lineItemsJson !== undefined
        ? { lineItemsJson: lineItemsJson as Prisma.InputJsonValue }
        : {}),
    },
  });
}

/**
 * Mark an unavailable HELD card as merchant-spent without racing the abandon
 * path. Both the observed purchase state and the absence of an active/finished
 * reclaim are predicates of the same database statement.
 */
export async function markHeldPurchaseClearedIfNoReclaim(id: string) {
  return runTransactionWithRetry(async (transaction) => {
    await lockPurchaseWalletTransition(transaction, id);
    return transaction.purchaseSpend.updateMany({
      where: {
        id,
        status: PurchaseSpendStatus.HELD,
        walletFunding: {
          isNot: {
            status: {
              in: [
                PurchaseWalletFundingStatus.RECLAIMING,
                PurchaseWalletFundingStatus.RECLAIMED,
                PurchaseWalletFundingStatus.RECLAIM_FAILED,
              ],
            },
          },
        },
      },
      data: { status: PurchaseSpendStatus.CLEARED },
    });
  });
}

/**
 * Move a crashed company-flow call out of CHARGING without letting a stale reader overwrite a
 * newer retry. The exact updatedAt value is the optimistic lease observed by the caller.
 */
export async function markStalePurchaseFundingPending(id: string, observedUpdatedAt: Date) {
  return prisma.purchaseSpend.updateMany({
    where: {
      id,
      status: PurchaseSpendStatus.CHARGING,
      cardId: null,
      updatedAt: observedUpdatedAt,
    },
    data: { status: PurchaseSpendStatus.FUNDING_PENDING },
  });
}

/** Claim one durable funding retry. Concurrent callers cannot both own the same provider replay. */
export async function claimFundingPendingPurchase(id: string, admission?: PurchaseAgentAdmission) {
  return runTransactionWithRetry(async (tx) => {
    const purchase = await tx.purchaseSpend.findUnique({ where: { id } });
    if (purchase === null) return null;
    const candidateAgentId = admission?.agentId?.trim();
    const requestedAgentId =
      candidateAgentId !== undefined && candidateAgentId !== '' ? candidateAgentId : undefined;
    if (
      (admission !== undefined && admission.userId !== purchase.userId) ||
      (requestedAgentId !== undefined &&
        purchase.agentId !== null &&
        purchase.agentId !== requestedAgentId)
    ) {
      throw new PurchaseError(
        'The agent is no longer available for this purchase',
        409,
        'purchase_agent_unavailable'
      );
    }
    const agentId = await lockPurchaseAgentAdmission(tx, {
      userId: purchase.userId,
      agentId: requestedAgentId ?? purchase.agentId ?? undefined,
    });
    const claimed = await tx.purchaseSpend.updateMany({
      // Another agent can adopt a legacy row and requeue it while this caller
      // waits for its generation lock. Preserve the ownership we actually read.
      where: {
        id,
        agentId: purchase.agentId,
        status: PurchaseSpendStatus.FUNDING_PENDING,
        cardId: null,
      },
      data: {
        status: PurchaseSpendStatus.CHARGING,
        // Legacy null-agent retries become owned by the verified requesting
        // agent before any new provider effect, so terminal cleanup can find them.
        ...(purchase.agentId === null && agentId !== undefined ? { agentId } : {}),
      },
    });
    if (claimed.count !== 1) return null;
    if (purchase.agentId === null && agentId !== undefined) {
      await tx.purchaseWalletFunding.updateMany({
        where: { purchaseId: id, agentId: null },
        data: { agentId },
      });
    }
    return tx.purchaseSpend.findUniqueOrThrow({ where: { id } });
  });
}

/** Stop user retries before canceling their Stripe hold; the compensator owns the provider replay. */
export async function markFundingPendingAbandoned(id: string, observedUpdatedAt: Date) {
  return prisma.purchaseSpend.updateMany({
    where: {
      id,
      status: PurchaseSpendStatus.FUNDING_PENDING,
      cardId: null,
      updatedAt: observedUpdatedAt,
    },
    data: { status: PurchaseSpendStatus.FUNDING_ABANDONED },
  });
}

export * from './repoGmv';
export * from './repoRead';
export * from './repoWalletFunding';

export {
  settlePurchaseAfterTransactionCleared,
  type SettlePurchaseClearedResult,
} from './repoSettlement';
