import { PurchaseWalletFundingStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

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
