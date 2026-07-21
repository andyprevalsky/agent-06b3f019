import { Prisma, PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { canonicalStoredPurchaseFingerprint } from './fingerprint';

const FINGERPRINT_BACKFILL_LOCK_SEED = 8_675_309;
const IDEMPOTENT_PURCHASE_STATUSES = [
  PurchaseSpendStatus.PENDING_APPROVAL,
  PurchaseSpendStatus.CHARGING,
  PurchaseSpendStatus.HELD,
];

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
  fingerprint: string
) {
  return prisma.purchaseSpend.findFirst({
    where: {
      userId,
      OR: [{ fingerprint }, { canonicalFingerprint: fingerprint }],
    },
    orderBy: { createdAt: 'desc' },
  });
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
  return prisma.purchaseSpend.create({
    data: {
      userId: data.userId,
      agentId: data.agentId,
      fingerprint: data.fingerprint,
      canonicalFingerprint: data.canonicalFingerprint,
      merchant: data.merchant,
      lineItemsJson: data.lineItemsJson as Prisma.InputJsonValue,
      totalCents: data.totalCents,
      status: PurchaseSpendStatus.PENDING_APPROVAL,
    },
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

export async function createOrGetWalletFunding(data: {
  purchaseId: string;
  userId: string;
  agentId?: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}) {
  return prisma.purchaseWalletFunding.upsert({
    where: { purchaseId: data.purchaseId },
    create: {
      purchaseId: data.purchaseId,
      userId: data.userId,
      agentId: data.agentId,
      amountCents: data.amountCents,
      currency: data.currency,
      idempotencyKey: data.idempotencyKey,
      status: PurchaseWalletFundingStatus.PENDING,
    },
    update: {},
  });
}

export async function findWalletFundingByPurchaseId(purchaseId: string) {
  return prisma.purchaseWalletFunding.findUnique({ where: { purchaseId } });
}

export async function markWalletFundingFunded(
  id: string,
  data: {
    providerTransferId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  return prisma.purchaseWalletFunding.update({
    where: { id },
    data: {
      status: PurchaseWalletFundingStatus.FUNDED,
      providerTransferId: data.providerTransferId,
      metadata: data.metadata as Prisma.InputJsonValue | undefined,
      errorMessage: null,
      fundedAt: new Date(),
    },
  });
}

export async function markWalletFundingFailed(id: string, error: string) {
  return prisma.purchaseWalletFunding.update({
    where: { id },
    data: {
      status: PurchaseWalletFundingStatus.FAILED,
      errorMessage: error,
    },
  });
}

export async function markWalletFundingConsumed(purchaseId: string) {
  return prisma.purchaseWalletFunding.updateMany({
    where: {
      purchaseId,
      status: { in: [PurchaseWalletFundingStatus.FUNDED, PurchaseWalletFundingStatus.CONSUMED] },
    },
    data: {
      status: PurchaseWalletFundingStatus.CONSUMED,
      consumedAt: new Date(),
      errorMessage: null,
    },
  });
}

export async function markWalletFundingReclaiming(
  id: string,
  data: { reclaimIdempotencyKey: string }
) {
  return prisma.purchaseWalletFunding.update({
    where: { id },
    data: {
      status: PurchaseWalletFundingStatus.RECLAIMING,
      reclaimIdempotencyKey: data.reclaimIdempotencyKey,
      errorMessage: null,
    },
  });
}

export async function markWalletFundingReclaimed(
  id: string,
  data: {
    providerTransferId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  return prisma.purchaseWalletFunding.update({
    where: { id },
    data: {
      status: PurchaseWalletFundingStatus.RECLAIMED,
      reclaimProviderTransferId: data.providerTransferId,
      metadata: data.metadata as Prisma.InputJsonValue | undefined,
      errorMessage: null,
      reclaimedAt: new Date(),
    },
  });
}

export async function markWalletFundingReclaimFailed(id: string, error: string) {
  return prisma.purchaseWalletFunding.update({
    where: { id },
    data: {
      status: PurchaseWalletFundingStatus.RECLAIM_FAILED,
      errorMessage: error,
    },
  });
}

export async function findSubscriptionByUserId(userId: string) {
  return prisma.subscription.findUnique({
    where: { userId },
  });
}

export async function findPurchaseByCardId(cardId: string) {
  return prisma.purchaseSpend.findFirst({
    where: { cardId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findHeldPurchasesByTotal(totalCents: number, limit = 10) {
  return prisma.purchaseSpend.findMany({
    where: { totalCents, status: PurchaseSpendStatus.HELD, cardId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export {
  settlePurchaseAfterTransactionCleared,
  type SettlePurchaseClearedResult,
} from './repoSettlement';
