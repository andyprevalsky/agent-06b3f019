import { PurchaseSpendStatus, PurchaseWalletFundingStatus, type Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';

export async function lockPurchaseWalletTransition(
  transaction: Prisma.TransactionClient,
  purchaseId: string
): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`purchase-wallet-transition:${purchaseId}`}))
  `;
}

export async function createOrGetWalletFunding(data: {
  purchaseId: string;
  userId: string;
  agentId?: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  cardProviderRail?: 'v2';
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
      ...(data.cardProviderRail ? { metadata: { cardProviderRail: data.cardProviderRail } } : {}),
    },
    update: {},
  });
}

export async function findWalletFundingByPurchaseId(purchaseId: string) {
  return prisma.purchaseWalletFunding.findUnique({ where: { purchaseId } });
}

export async function deletePendingWalletFunding(purchaseId: string) {
  return prisma.purchaseWalletFunding.deleteMany({
    where: { purchaseId, status: PurchaseWalletFundingStatus.PENDING },
  });
}

// Only a funding attempt that is still in flight (PENDING) or previously FAILED may transition to
// FUNDED/FAILED. Guarding the source status as a compare-and-set stops a late/duplicate funding
// callback from resurrecting a RECLAIMING/RECLAIMED/CONSUMED row back to FUNDED, and stops a
// concurrent failed attempt from downgrading an already-FUNDED transfer to FAILED.
const FUNDING_IN_FLIGHT_STATUSES = [
  PurchaseWalletFundingStatus.PENDING,
  PurchaseWalletFundingStatus.FAILED,
];

export async function markWalletFundingFunded(
  id: string,
  data: {
    providerTransferId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  await prisma.purchaseWalletFunding.updateMany({
    where: { id, status: { in: FUNDING_IN_FLIGHT_STATUSES } },
    data: {
      status: PurchaseWalletFundingStatus.FUNDED,
      providerTransferId: data.providerTransferId,
      metadata: data.metadata as Prisma.InputJsonValue | undefined,
      errorMessage: null,
      fundedAt: new Date(),
    },
  });
  // Return the current row regardless: a no-op update means the funding already advanced past the
  // in-flight window (e.g. a concurrent reclaim), and callers must observe that real state.
  return prisma.purchaseWalletFunding.findUniqueOrThrow({ where: { id } });
}

/**
 * Persist the two external facts returned by one successful AgentCard create call in one DB
 * transaction. A crash can therefore leave neither pointer or both pointers, never a card without
 * its transfer (or a transfer without the card needed to close it).
 */
export async function recordIssuedCardAndFunding(data: {
  purchaseId: string;
  fundingId: string;
  cardId: string;
  providerTransferId: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.$transaction(async (transaction) => {
    const funding = await transaction.purchaseWalletFunding.findUniqueOrThrow({
      where: { id: data.fundingId },
    });
    if (
      funding.status === PurchaseWalletFundingStatus.PENDING ||
      funding.status === PurchaseWalletFundingStatus.FAILED ||
      (funding.status === PurchaseWalletFundingStatus.FUNDED && funding.providerTransferId === null)
    ) {
      await transaction.purchaseWalletFunding.update({
        where: { id: funding.id },
        data: {
          status: PurchaseWalletFundingStatus.FUNDED,
          providerTransferId: data.providerTransferId,
          metadata: {
            ...(data.metadata ?? {}),
            status: 'company_flow_transfer_recorded',
            transfer_id: data.providerTransferId,
          } as Prisma.InputJsonValue,
          errorMessage: null,
          fundedAt: new Date(),
        },
      });
    } else if (
      funding.status !== PurchaseWalletFundingStatus.FUNDED ||
      (funding.providerTransferId !== null &&
        funding.providerTransferId !== data.providerTransferId)
    ) {
      throw new Error('Purchase wallet funding changed before issued-card persistence');
    }

    const cardWrite = await transaction.purchaseSpend.updateMany({
      where: {
        id: data.purchaseId,
        status: {
          in: [PurchaseSpendStatus.CHARGING, PurchaseSpendStatus.FUNDING_ABANDONED],
        },
        OR: [{ cardId: null }, { cardId: data.cardId }],
      },
      data: { cardId: data.cardId },
    });
    if (cardWrite.count !== 1) {
      throw new Error('Purchase changed before issued-card persistence');
    }
    return transaction.purchaseWalletFunding.findUniqueOrThrow({ where: { id: funding.id } });
  });
}

export async function markWalletFundingFailed(id: string, error: string) {
  await prisma.purchaseWalletFunding.updateMany({
    where: { id, status: { in: FUNDING_IN_FLIGHT_STATUSES } },
    data: {
      status: PurchaseWalletFundingStatus.FAILED,
      errorMessage: error,
    },
  });
  return prisma.purchaseWalletFunding.findUniqueOrThrow({ where: { id } });
}

export async function markWalletFundingConsumed(purchaseId: string) {
  return prisma.purchaseWalletFunding.updateMany({
    where: {
      purchaseId,
      status: {
        in: [
          PurchaseWalletFundingStatus.FUNDED,
          PurchaseWalletFundingStatus.CONSUMED,
          PurchaseWalletFundingStatus.RECLAIMING,
          PurchaseWalletFundingStatus.RECLAIM_FAILED,
        ],
      },
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
  data: {
    reclaimIdempotencyKey: string;
    reclaimLeaseToken: string;
    expectedReclaimLeaseToken: string | null;
    allowConsumed: boolean;
    allowReclaiming: boolean;
  }
) {
  return runTransactionWithRetry(async (transaction) => {
    const funding = await transaction.purchaseWalletFunding.findUnique({
      where: { id },
      select: { purchaseId: true },
    });
    if (funding === null) return { count: 0 };
    await lockPurchaseWalletTransition(transaction, funding.purchaseId);
    return transaction.purchaseWalletFunding.updateMany({
      where: {
        id,
        purchaseId: funding.purchaseId,
        reclaimLeaseToken: data.expectedReclaimLeaseToken,
        status: {
          in: [
            PurchaseWalletFundingStatus.FUNDED,
            PurchaseWalletFundingStatus.RECLAIM_FAILED,
            ...(data.allowReclaiming ? [PurchaseWalletFundingStatus.RECLAIMING] : []),
            ...(data.allowConsumed ? [PurchaseWalletFundingStatus.CONSUMED] : []),
          ],
        },
        purchase: { status: { not: PurchaseSpendStatus.CLEARED } },
      },
      data: {
        status: PurchaseWalletFundingStatus.RECLAIMING,
        reclaimIdempotencyKey: data.reclaimIdempotencyKey,
        reclaimLeaseToken: data.reclaimLeaseToken,
        errorMessage: null,
      },
    });
  });
}

/**
 * Claim the first close/reclaim attempt for a funded transfer. Unlike
 * `markWalletFundingReclaiming`, this is intentionally a FUNDED-only CAS: a second cleanup that
 * arrives while the first one is polling AgentCard must not replay `close_card`. Even though
 * AgentCard declares close idempotent, the mutation has exactly one owner; all retry paths only
 * observe the resulting transfer release.
 */
export async function claimWalletFundingReclaim(
  id: string,
  purchaseId: string,
  data: { reclaimIdempotencyKey: string; reclaimLeaseToken: string }
) {
  return runTransactionWithRetry(async (transaction) => {
    await lockPurchaseWalletTransition(transaction, purchaseId);
    return transaction.purchaseWalletFunding.updateMany({
      where: {
        id,
        purchaseId,
        status: PurchaseWalletFundingStatus.FUNDED,
        // Reciprocal guard: if clearing won the serialized transition, a
        // later reclaim must not create CLEARED + RECLAIMING.
        purchase: { status: { not: PurchaseSpendStatus.CLEARED } },
      },
      data: {
        status: PurchaseWalletFundingStatus.RECLAIMING,
        reclaimIdempotencyKey: data.reclaimIdempotencyKey,
        reclaimLeaseToken: data.reclaimLeaseToken,
        errorMessage: null,
      },
    });
  });
}

/**
 * Take ownership of a retryable reclaim. The stale timestamp is part of the compare-and-set so
 * concurrent cron workers cannot both revive the same expired lease and poll provider cleanup.
 * FUNDED is included for legacy rows whose purchase was marked FUNDING_RECLAIM_FAILED before the
 * funding row advanced to RECLAIM_FAILED.
 */
export async function claimWalletFundingReclaimRetry(
  id: string,
  data: {
    reclaimIdempotencyKey: string;
    reclaimLeaseToken: string;
    staleReclaimingBefore: Date;
  }
) {
  return runTransactionWithRetry(async (transaction) => {
    const funding = await transaction.purchaseWalletFunding.findUnique({
      where: { id },
      select: { purchaseId: true },
    });
    if (funding === null) return { count: 0 };
    await lockPurchaseWalletTransition(transaction, funding.purchaseId);
    return transaction.purchaseWalletFunding.updateMany({
      where: {
        id,
        purchaseId: funding.purchaseId,
        OR: [
          { status: PurchaseWalletFundingStatus.FUNDED },
          { status: PurchaseWalletFundingStatus.RECLAIM_FAILED },
          {
            status: PurchaseWalletFundingStatus.RECLAIMING,
            updatedAt: { lte: data.staleReclaimingBefore },
          },
        ],
        purchase: { status: { not: PurchaseSpendStatus.CLEARED } },
      },
      data: {
        status: PurchaseWalletFundingStatus.RECLAIMING,
        reclaimIdempotencyKey: data.reclaimIdempotencyKey,
        reclaimLeaseToken: data.reclaimLeaseToken,
        errorMessage: null,
      },
    });
  });
}

export async function markWalletFundingReclaimed(
  id: string,
  reclaimLeaseToken: string,
  data: {
    providerTransferId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  return prisma.purchaseWalletFunding.updateMany({
    where: { id, status: PurchaseWalletFundingStatus.RECLAIMING, reclaimLeaseToken },
    data: {
      status: PurchaseWalletFundingStatus.RECLAIMED,
      reclaimProviderTransferId: data.providerTransferId,
      metadata: data.metadata as Prisma.InputJsonValue | undefined,
      errorMessage: null,
      reclaimedAt: new Date(),
    },
  });
}

export async function markWalletFundingReclaimFailed(
  id: string,
  reclaimLeaseToken: string,
  error: string
) {
  return prisma.purchaseWalletFunding.updateMany({
    where: { id, status: PurchaseWalletFundingStatus.RECLAIMING, reclaimLeaseToken },
    data: {
      status: PurchaseWalletFundingStatus.RECLAIM_FAILED,
      errorMessage: error,
    },
  });
}
