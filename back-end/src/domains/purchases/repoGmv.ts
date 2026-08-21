import { PurchaseSpendStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

const STRUCTURED_GMV_PROVIDERS = ['order_confirmation', 'merchant_saved'] as const;

export async function findAgentcardCoveringPurchase(input: {
  agentId: string;
  totalCents: number;
  statuses: PurchaseSpendStatus[];
  since: Date;
}): Promise<{ id: string } | null> {
  return prisma.purchaseSpend.findFirst({
    where: {
      agentId: input.agentId,
      provider: { notIn: [...STRUCTURED_GMV_PROVIDERS] },
      status: { in: input.statuses },
      totalCents: input.totalCents,
      createdAt: { gte: input.since },
    },
    select: { id: true },
  });
}

export async function findOrderConfirmationByFingerprint(input: {
  userId: string;
  fingerprint: string;
  confirmationId: string;
}): Promise<{ id: string } | null> {
  return prisma.purchaseSpend.findFirst({
    where: {
      userId: input.userId,
      OR: [
        { fingerprint: input.fingerprint },
        {
          provider: 'order_confirmation',
          lineItemsJson: {
            path: ['confirmationId'],
            equals: input.confirmationId,
          },
        },
      ],
    },
    select: { id: true },
  });
}

export async function createClearedOrderConfirmation(input: {
  userId: string;
  agentId: string | undefined;
  fingerprint: string;
  merchant: string;
  lineItemsJson: Record<string, unknown>;
  totalCents: number;
  createdAt?: Date;
}): Promise<{ id: string }> {
  return prisma.purchaseSpend.create({
    data: {
      userId: input.userId,
      agentId: input.agentId,
      fingerprint: input.fingerprint,
      canonicalFingerprint: input.fingerprint,
      merchant: input.merchant,
      lineItemsJson: input.lineItemsJson as Prisma.InputJsonValue,
      totalCents: input.totalCents,
      status: PurchaseSpendStatus.CLEARED,
      provider: 'order_confirmation',
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    },
    select: { id: true },
  });
}
