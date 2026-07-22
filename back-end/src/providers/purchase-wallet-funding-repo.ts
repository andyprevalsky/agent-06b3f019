import { PurchaseWalletFundingStatus, type Prisma } from '@prisma/client';
import { prisma } from './database';

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
  data: { reclaimIdempotencyKey: string; allowConsumed: boolean }
) {
  return prisma.purchaseWalletFunding.updateMany({
    where: {
      id,
      status: {
        in: [
          PurchaseWalletFundingStatus.FUNDED,
          PurchaseWalletFundingStatus.RECLAIMING,
          PurchaseWalletFundingStatus.RECLAIM_FAILED,
          ...(data.allowConsumed ? [PurchaseWalletFundingStatus.CONSUMED] : []),
        ],
      },
    },
    data: {
      status: PurchaseWalletFundingStatus.RECLAIMING,
      reclaimIdempotencyKey: data.reclaimIdempotencyKey,
      errorMessage: null,
    },
  });
}

/**
 * Claim the first close/reclaim attempt for a funded transfer. Unlike
 * `markWalletFundingReclaiming`, this is intentionally a FUNDED-only CAS: a second cleanup that
 * arrives while the first one is polling AgentCard must not replay `close_card`. AgentCard declares
 * close idempotent, but overlapping closes can strand a sandbox company transfer as `consumed`
 * after the card is already CLOSED/$0, leaving no provider-side recovery operation.
 */
export async function claimWalletFundingReclaim(
  id: string,
  data: { reclaimIdempotencyKey: string }
) {
  return prisma.purchaseWalletFunding.updateMany({
    where: { id, status: PurchaseWalletFundingStatus.FUNDED },
    data: {
      status: PurchaseWalletFundingStatus.RECLAIMING,
      reclaimIdempotencyKey: data.reclaimIdempotencyKey,
      errorMessage: null,
    },
  });
}

/**
 * Take ownership of a retryable reclaim. The stale timestamp is part of the compare-and-set so
 * concurrent cron workers cannot both revive the same expired lease and replay provider cleanup.
 * FUNDED is included for legacy rows whose purchase was marked FUNDING_RECLAIM_FAILED before the
 * funding row advanced to RECLAIM_FAILED.
 */
export async function claimWalletFundingReclaimRetry(
  id: string,
  data: { reclaimIdempotencyKey: string; staleReclaimingBefore: Date }
) {
  return prisma.purchaseWalletFunding.updateMany({
    where: {
      id,
      OR: [
        { status: PurchaseWalletFundingStatus.FUNDED },
        { status: PurchaseWalletFundingStatus.RECLAIM_FAILED },
        {
          status: PurchaseWalletFundingStatus.RECLAIMING,
          updatedAt: { lte: data.staleReclaimingBefore },
        },
      ],
    },
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
  return prisma.purchaseWalletFunding.updateMany({
    where: { id, status: PurchaseWalletFundingStatus.RECLAIMING },
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
  return prisma.purchaseWalletFunding.updateMany({
    where: { id, status: PurchaseWalletFundingStatus.RECLAIMING },
    data: {
      status: PurchaseWalletFundingStatus.RECLAIM_FAILED,
      errorMessage: error,
    },
  });
}
