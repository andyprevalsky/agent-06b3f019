import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function findSubscriptionByUserId(userId: string) {
  return prisma.subscription.findUnique({ where: { userId } });
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
