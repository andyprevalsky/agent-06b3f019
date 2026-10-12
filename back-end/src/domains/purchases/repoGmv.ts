import { PurchaseSpendStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

const STRUCTURED_GMV_PROVIDERS = ['order_confirmation', 'merchant_saved'] as const;

/** Tax, shipping and fees on top of a subtotal: 35% plus $20 covers the cases seen. */
export function coveringPurchaseCeilingCents(totalCents: number): number {
  return Math.round(totalCents * 1.35) + 2000;
}

export async function findAgentcardCoveringPurchase(input: {
  agentId: string;
  totalCents: number;
  statuses: PurchaseSpendStatus[];
  since: Date;
  /** Backfills bound the match by the event's own time; a later charge is not its cover. */
  until?: Date;
}): Promise<{ id: string } | null> {
  return prisma.purchaseSpend.findFirst({
    where: {
      agentId: input.agentId,
      provider: { notIn: [...STRUCTURED_GMV_PROVIDERS] },
      status: { in: input.statuses },
      // The structured output may carry an item price or subtotal rather than
      // the charged total (selected_product_price_usd: 15.00 against a $21.23
      // card purchase); the card row then still covers it. The bound keeps an
      // unrelated larger charge from swallowing a small structured sale.
      totalCents: { gte: input.totalCents, lte: coveringPurchaseCeilingCents(input.totalCents) },
      createdAt: { gte: input.since, ...(input.until !== undefined ? { lte: input.until } : {}) },
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
