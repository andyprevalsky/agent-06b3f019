import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { reconcileFailedPurchaseFundingReclaims } from '../../providers/purchaseCleanup';
import { FakeWalletFundingProvider, StubCardStateProvider } from '../blackbox/purchases.testkit';

export const createdUserIds: string[] = [];
export let passed = 0;
export const failures: string[] = [];

export async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

export async function seedUser(): Promise<string> {
  const userId = `cleanup-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

export async function seedAgent(userId: string, status: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: { userId, goal: 'cleanup test', status: status as never },
  });
  return agent.id;
}

export async function seedHeld(
  userId: string,
  opts: { agentId?: string; cardId?: string; status?: PurchaseSpendStatus } = {}
): Promise<string> {
  const row = await prisma.purchaseSpend.create({
    data: {
      userId,
      agentId: opts.agentId,
      fingerprint: `fp-${randomUUID()}`,
      merchant: 'Cleanup Merchant',
      lineItemsJson: { totalCents: 1080 },
      totalCents: 1080,
      status: opts.status ?? PurchaseSpendStatus.HELD,
      cardId: opts.cardId ?? `card-${randomUUID()}`,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });
  return row.id;
}

export async function seedStaleCharging(userId: string) {
  return prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `fp-${randomUUID()}`,
      merchant: 'Stale Merchant',
      lineItemsJson: { totalCents: 1080 },
      totalCents: 1080,
      status: PurchaseSpendStatus.CHARGING,
      cardId: `card-${randomUUID()}`,
      stripePaymentIntentId: `pi_${randomUUID()}`,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
}

export async function seedFunding(
  purchaseId: string,
  userId: string,
  status: PurchaseWalletFundingStatus = PurchaseWalletFundingStatus.FUNDED
): Promise<void> {
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId,
      userId,
      amountCents: 1080,
      currency: 'usd',
      status,
      providerTransferId: `owt_${randomUUID()}`,
      idempotencyKey: `purchase-wallet-fund:${purchaseId}`,
    },
  });
}

export async function statusOf(purchaseId: string): Promise<PurchaseSpendStatus | undefined> {
  const row = await prisma.purchaseSpend.findUnique({ where: { id: purchaseId } });
  return row?.status;
}

export async function reconcileFailed(
  wallet: FakeWalletFundingProvider,
  userId: string
): Promise<void> {
  await reconcileFailedPurchaseFundingReclaims(
    wallet,
    { userId },
    new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 })
  );
}

export async function cleanupUsers(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}
