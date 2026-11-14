import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function findSubscriptionByUserId(userId: string) {
  return prisma.subscription.findUnique({ where: { userId } });
}

/** Omit userId only for trusted provider-event/internal reconciliation lookups. */
export async function findPurchaseByCardId(cardId: string, userId?: string) {
  return prisma.purchaseSpend.findFirst({
    where: { cardId, ...(userId !== undefined ? { userId } : {}) },
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

export async function findHeldPurchasesForAgentCart(query: {
  userId: string;
  agentId: string;
  merchant: string;
  totalCents: number;
  since: Date;
  take: number;
}) {
  return prisma.purchaseSpend.findMany({
    where: {
      userId: query.userId,
      agentId: query.agentId,
      merchant: { equals: query.merchant, mode: 'insensitive' },
      totalCents: query.totalCents,
      status: PurchaseSpendStatus.HELD,
      cardId: { not: null },
      createdAt: { gte: query.since },
    },
    orderBy: { createdAt: 'desc' },
    take: query.take,
  });
}
