import { PurchaseSpendStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function findPurchaseByUserAndFingerprint(userId: string, fingerprint: string) {
  return prisma.purchaseSpend.findUnique({
    where: { userId_fingerprint: { userId, fingerprint } },
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
      fingerprint,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createPendingPurchase(data: {
  userId: string;
  agentId?: string;
  fingerprint: string;
  merchant: string;
  lineItemsJson: unknown;
  totalCents: number;
}) {
  return prisma.purchaseSpend.create({
    data: {
      userId: data.userId,
      agentId: data.agentId,
      fingerprint: data.fingerprint,
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
      ...(lineItemsJson !== undefined ? { lineItemsJson: lineItemsJson as Prisma.InputJsonValue } : {}),
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
