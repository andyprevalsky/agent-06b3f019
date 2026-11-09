#!/usr/bin/env tsx
/** Regression coverage for closed AgentCard cleanup and admin no-charge reclaim retries. */

import assert from 'node:assert/strict';
import { assertIssuedLedgerCleanup } from '../blackbox/purchases-issued-ledger.cases';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { AgentCardProviderError, type CardProvider } from '../../providers/card-provider';
import { prisma } from '../../providers/database';
import { consumePurchaseWalletFunding } from '../../providers/purchase-wallet-funding';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import { FakeWalletFundingProvider, withFakeStripe } from '../blackbox/purchases.testkit';

const userId = `cleanup-closed-card-${randomUUID()}`;

class ClosedCardErrorProvider implements CardProvider {
  closeCalls = 0;
  detailsCalls = 0;

  async mintCard(): Promise<never> {
    throw new Error('ClosedCardErrorProvider.mintCard should not be called');
  }

  async getDetails(): Promise<never> {
    this.detailsCalls += 1;
    throw new AgentCardProviderError(
      'get_card_details failed: card_closed: credentials are unavailable',
      409,
      undefined,
      'card_closed'
    );
  }

  async closeCard(): Promise<never> {
    this.closeCalls += 1;
    throw new Error('close_card failed: card_closed: card is already closed');
  }
}

async function seedPurchase(
  agentId: string,
  fundingStatus: PurchaseWalletFundingStatus,
  stripePaymentIntentId: string | null
): Promise<string> {
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId,
      agentId,
      fingerprint: `fp-${randomUUID()}`,
      merchant: 'Cleanup Merchant',
      lineItemsJson: { totalCents: 1080 },
      totalCents: 1080,
      status: PurchaseSpendStatus.HELD,
      cardId: `card-${randomUUID()}`,
      stripePaymentIntentId,
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId,
      amountCents: 1080,
      currency: 'usd',
      status: fundingStatus,
      providerTransferId: `owt_${randomUUID()}`,
      idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
    },
  });
  return purchase.id;
}

async function main(): Promise<void> {
  assertIssuedLedgerCleanup(process.cwd());
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const agent = await prisma.agent.create({
    data: { userId, goal: 'closed card cleanup test', status: 'COMPLETED' },
  });

  const settledPurchaseId = await seedPurchase(
    agent.id,
    PurchaseWalletFundingStatus.FUNDED,
    `pi_${randomUUID()}`
  );
  const settledWallet = new FakeWalletFundingProvider();
  // Model an interrupted settlement projection: funding consumption was persisted before
  // the separate purchase update. Card closure alone does not establish merchant spend.
  await consumePurchaseWalletFunding(settledPurchaseId);
  const interruptedSettlement = await prisma.purchaseSpend.findUniqueOrThrow({
    where: { id: settledPurchaseId },
    include: { walletFunding: true },
  });
  assert.equal(interruptedSettlement.status, PurchaseSpendStatus.HELD);
  assert.equal(interruptedSettlement.walletFunding?.status, PurchaseWalletFundingStatus.CONSUMED);
  assert.ok(interruptedSettlement.walletFunding?.consumedAt);
  const settledProvider = new ClosedCardErrorProvider();
  await withFakeStripe(async (calls) => {
    await cleanupAgentPurchaseCards(agent.id, settledProvider, settledWallet);
    assert.equal(calls.refunds.length, 0, 'confirmed spend must not be refunded');
    assert.equal(calls.cancels.length, 0, 'confirmed spend must not be canceled');
  });
  const settledPurchase = await prisma.purchaseSpend.findUniqueOrThrow({
    where: { id: settledPurchaseId },
    include: { walletFunding: true },
  });
  assert.equal(settledPurchase.status, PurchaseSpendStatus.CLEARED);
  assert.equal(settledPurchase.walletFunding?.status, PurchaseWalletFundingStatus.CONSUMED);
  assert.equal(
    settledProvider.detailsCalls,
    1,
    'cleanup must observe the typed closed-card response'
  );
  assert.equal(settledProvider.closeCalls, 0);
  assert.equal(settledWallet.reclaimCalls.length, 0);

  const noChargePurchaseId = await seedPurchase(
    agent.id,
    PurchaseWalletFundingStatus.RECLAIMING,
    null
  );
  await prisma.purchaseWalletFunding.update({
    where: { purchaseId: noChargePurchaseId },
    data: { updatedAt: new Date(Date.now() - 3 * 60 * 1000) },
  });
  const closedProvider = new ClosedCardErrorProvider();
  const noChargeWallet = new FakeWalletFundingProvider();
  await withFakeStripe(async (calls) => {
    await cleanupAgentPurchaseCards(agent.id, closedProvider, noChargeWallet);
    assert.equal(calls.refunds.length, 0, 'an admin no-charge purchase has no Stripe refund');
    assert.equal(calls.cancels.length, 0, 'an admin no-charge purchase has no Stripe hold');
  });
  const noChargePurchase = await prisma.purchaseSpend.findUniqueOrThrow({
    where: { id: noChargePurchaseId },
    include: { walletFunding: true },
  });
  assert.equal(closedProvider.closeCalls, 1);
  assert.equal(noChargeWallet.reclaimCalls.length, 1);
  assert.equal(noChargePurchase.status, PurchaseSpendStatus.VOIDED);
  assert.equal(noChargePurchase.walletFunding?.status, PurchaseWalletFundingStatus.RECLAIMED);

  const alreadyReclaimedPurchaseId = await seedPurchase(
    agent.id,
    PurchaseWalletFundingStatus.RECLAIMED,
    null
  );
  const alreadyClosedProvider = new ClosedCardErrorProvider();
  const alreadyReclaimedWallet = new FakeWalletFundingProvider();
  await withFakeStripe(async () => {
    await cleanupAgentPurchaseCards(agent.id, alreadyClosedProvider, alreadyReclaimedWallet);
  });
  const alreadyReclaimedPurchase = await prisma.purchaseSpend.findUniqueOrThrow({
    where: { id: alreadyReclaimedPurchaseId },
    include: { walletFunding: true },
  });
  assert.equal(alreadyClosedProvider.closeCalls, 1);
  assert.equal(alreadyReclaimedWallet.reclaimCalls.length, 0);
  assert.equal(alreadyReclaimedPurchase.status, PurchaseSpendStatus.VOIDED);
  assert.equal(
    alreadyReclaimedPurchase.walletFunding?.status,
    PurchaseWalletFundingStatus.RECLAIMED
  );

  process.stdout.write('PASS closed AgentCard purchase cleanup regressions\n');
}

async function cleanup(): Promise<void> {
  await prisma.purchaseSpend.deleteMany({ where: { userId } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
  await prisma.$disconnect();
}

main()
  .then(cleanup)
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await cleanup();
    process.exit(1);
  });
