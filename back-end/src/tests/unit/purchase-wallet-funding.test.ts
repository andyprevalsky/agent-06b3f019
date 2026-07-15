#!/usr/bin/env tsx
/**
 * Unit tests for the purchase wallet-funding orchestration
 * (`providers/purchase-wallet-funding.ts`) and its repo
 * (`providers/purchase-wallet-funding-repo.ts`).
 *
 * Drives the fund/confirm/record/consume/reclaim lifecycle against the live local
 * Postgres with injected wallet-funding providers, asserting each terminal status
 * and the idempotent short-circuits.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  PurchaseSpendStatus,
  PurchaseWalletFundingStatus,
  type PurchaseSpend,
} from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  confirmPurchaseWalletCollection,
  consumePurchaseWalletFunding,
  fundPurchaseWallet,
  reclaimPurchaseWalletFunding,
  recordPurchaseWalletFunding,
} from '../../providers/purchase-wallet-funding';
import { findWalletFundingByPurchaseId } from '../../providers/purchase-wallet-funding-repo';
import {
  WalletFundingProviderError,
  type WalletFundingCollectionRequest,
  type WalletFundingProvider,
  type WalletFundingReclaimRequest,
  type WalletFundingRequest,
  type WalletFundingResult,
} from '../../providers/wallet-funding';

const createdUserIds: string[] = [];
let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

class FakeProvider implements WalletFundingProvider {
  fundCalls: WalletFundingRequest[] = [];
  confirmCalls: WalletFundingCollectionRequest[] = [];
  reclaimCalls: WalletFundingReclaimRequest[] = [];
  async fundUserWallet(request: WalletFundingRequest): Promise<WalletFundingResult> {
    this.fundCalls.push(request);
    return { providerTransferId: `wft_${request.purchaseId}`, metadata: { ok: true } };
  }
  async confirmCollection(request: WalletFundingCollectionRequest): Promise<WalletFundingResult> {
    this.confirmCalls.push(request);
    return { providerTransferId: request.providerTransferId, metadata: { confirmed: true } };
  }
  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    this.reclaimCalls.push(request);
    return { providerTransferId: `wfr_${request.purchaseId}`, metadata: { reclaimed: true } };
  }
}

class ThrowingReclaimProvider extends FakeProvider {
  constructor(private readonly error: Error) {
    super();
  }
  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    this.reclaimCalls.push(request);
    throw this.error;
  }
}

async function seedUser(): Promise<string> {
  const userId = `pwf-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

async function seedPurchase(userId: string): Promise<PurchaseSpend> {
  return prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `fp-${randomUUID()}`,
      merchant: 'PWF Merchant',
      lineItemsJson: { totalCents: 1080 },
      totalCents: 1080,
      status: PurchaseSpendStatus.CHARGING,
      cardId: `card-${randomUUID()}`,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });
}

async function setFundingStatus(
  purchaseId: string,
  status: PurchaseWalletFundingStatus
): Promise<void> {
  await prisma.purchaseWalletFunding.update({ where: { purchaseId }, data: { status } });
}

async function main(): Promise<void> {
  process.stdout.write('Running purchase wallet-funding unit tests...\n');

  await test('fundPurchaseWallet funds a fresh purchase', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    const provider = new FakeProvider();
    const funding = await fundPurchaseWallet(purchase, 'usd', provider);
    assert.equal(funding.status, PurchaseWalletFundingStatus.FUNDED);
    assert.equal(funding.providerTransferId, `wft_${purchase.id}`);
    assert.equal(provider.fundCalls.length, 1);
  });

  await test('fundPurchaseWallet short-circuits an already-funded purchase', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    const provider = new FakeProvider();
    await fundPurchaseWallet(purchase, 'usd', provider);
    const second = await fundPurchaseWallet(purchase, 'usd', provider);
    assert.equal(second.status, PurchaseWalletFundingStatus.FUNDED);
    assert.equal(provider.fundCalls.length, 1, 'no second provider call for a funded purchase');
  });

  await test('fundPurchaseWallet rejects a reclaimed purchase', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    const provider = new FakeProvider();
    await fundPurchaseWallet(purchase, 'usd', provider);
    await setFundingStatus(purchase.id, PurchaseWalletFundingStatus.RECLAIMED);
    await assert.rejects(() => fundPurchaseWallet(purchase, 'usd', provider), /already reclaimed/);
  });

  await test('fundPurchaseWallet marks funding FAILED when the provider throws', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    const provider: WalletFundingProvider = {
      fundUserWallet: async () => {
        throw new Error('provider down');
      },
      confirmCollection: async () => ({}),
      reclaimUserWalletFunding: async () => ({}),
    };
    await assert.rejects(() => fundPurchaseWallet(purchase, 'usd', provider), /provider down/);
    const funding = await findWalletFundingByPurchaseId(purchase.id);
    assert.equal(funding?.status, PurchaseWalletFundingStatus.FAILED);
    assert.equal(funding?.errorMessage, 'provider down');
  });

  await test('confirmPurchaseWalletCollection funds and merges metadata', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    const provider = new FakeProvider();
    const funding = await confirmPurchaseWalletCollection(
      purchase,
      'usd',
      'owt_transfer_1',
      { seeded: 'meta' },
      provider
    );
    assert.equal(funding.status, PurchaseWalletFundingStatus.FUNDED);
    assert.equal(funding.providerTransferId, 'owt_transfer_1');
    assert.deepEqual(funding.metadata, { seeded: 'meta', confirmed: true });
    assert.equal(provider.confirmCalls[0]?.outcome, 'succeeded');
  });

  await test('confirmPurchaseWalletCollection short-circuits an already-funded row', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    await recordPurchaseWalletFunding(purchase, 'usd', 'owt_pre', {});
    const provider = new FakeProvider();
    const funding = await confirmPurchaseWalletCollection(purchase, 'usd', 'owt_x', {}, provider);
    assert.equal(funding.status, PurchaseWalletFundingStatus.FUNDED);
    assert.equal(provider.confirmCalls.length, 0, 'no confirm call for an already-funded row');
  });

  await test('confirmPurchaseWalletCollection rejects a reclaimed row', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    await recordPurchaseWalletFunding(purchase, 'usd', 'owt_pre', {});
    await setFundingStatus(purchase.id, PurchaseWalletFundingStatus.RECLAIMED);
    await assert.rejects(
      () => confirmPurchaseWalletCollection(purchase, 'usd', 'owt_x', {}, new FakeProvider()),
      /already reclaimed/
    );
  });

  await test('confirmPurchaseWalletCollection marks FAILED when the provider throws', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    const provider: WalletFundingProvider = {
      fundUserWallet: async () => ({}),
      confirmCollection: async () => {
        throw new Error('confirm failed');
      },
      reclaimUserWalletFunding: async () => ({}),
    };
    await assert.rejects(
      () => confirmPurchaseWalletCollection(purchase, 'usd', 'owt_x', {}, provider),
      /confirm failed/
    );
    const funding = await findWalletFundingByPurchaseId(purchase.id);
    assert.equal(funding?.status, PurchaseWalletFundingStatus.FAILED);
    assert.equal(funding?.errorMessage, 'confirm failed');
  });

  await test('recordPurchaseWalletFunding stamps a company-flow transfer', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    const funding = await recordPurchaseWalletFunding(purchase, 'usd', 'owt_company_1', {
      note: 'x',
    });
    assert.equal(funding.status, PurchaseWalletFundingStatus.FUNDED);
    assert.equal(funding.providerTransferId, 'owt_company_1');
    const metadata = funding.metadata as Record<string, unknown>;
    assert.equal(metadata.status, 'company_flow_transfer_recorded');
    assert.equal(metadata.transfer_id, 'owt_company_1');
    // Idempotent: a second record for a funded row returns it unchanged.
    const again = await recordPurchaseWalletFunding(purchase, 'usd', 'owt_company_2', {});
    assert.equal(again.providerTransferId, 'owt_company_1');
  });

  await test('consumePurchaseWalletFunding moves FUNDED to CONSUMED', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    await recordPurchaseWalletFunding(purchase, 'usd', 'owt_consume', {});
    await consumePurchaseWalletFunding(purchase.id);
    const funding = await findWalletFundingByPurchaseId(purchase.id);
    assert.equal(funding?.status, PurchaseWalletFundingStatus.CONSUMED);
    assert.notEqual(funding?.consumedAt, null);
  });

  await test('reclaimPurchaseWalletFunding is a no-op with no funding row', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    const provider = new FakeProvider();
    await reclaimPurchaseWalletFunding(purchase, 'no_funding', provider);
    assert.equal(provider.reclaimCalls.length, 0);
  });

  await test('reclaimPurchaseWalletFunding reclaims a funded transfer', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    await recordPurchaseWalletFunding(purchase, 'usd', 'owt_reclaim', {});
    const provider = new FakeProvider();
    await reclaimPurchaseWalletFunding(
      { ...purchase, cardId: purchase.cardId },
      'agent_cleanup_unspent_card',
      provider
    );
    assert.equal(provider.reclaimCalls.length, 1);
    const funding = await findWalletFundingByPurchaseId(purchase.id);
    assert.equal(funding?.status, PurchaseWalletFundingStatus.RECLAIMED);
    assert.equal(funding?.reclaimProviderTransferId, `wfr_${purchase.id}`);
  });

  await test('reclaim skips PENDING/FAILED/RECLAIMED funding', async () => {
    const userId = await seedUser();
    const provider = new FakeProvider();
    for (const status of [
      PurchaseWalletFundingStatus.PENDING,
      PurchaseWalletFundingStatus.FAILED,
      PurchaseWalletFundingStatus.RECLAIMED,
    ]) {
      const purchase = await seedPurchase(userId);
      await recordPurchaseWalletFunding(purchase, 'usd', 'owt_skip', {});
      await setFundingStatus(purchase.id, status);
      await reclaimPurchaseWalletFunding(purchase, 'skip', provider);
    }
    assert.equal(provider.reclaimCalls.length, 0, 'terminal/pending funding must not be reclaimed');
  });

  await test('reclaim rejects a consumed transfer unless allowConsumed', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    await recordPurchaseWalletFunding(purchase, 'usd', 'owt_consumed', {});
    await setFundingStatus(purchase.id, PurchaseWalletFundingStatus.CONSUMED);
    const provider = new FakeProvider();
    await assert.rejects(
      () => reclaimPurchaseWalletFunding(purchase, 'voided', provider),
      (error: unknown) =>
        error instanceof WalletFundingProviderError &&
        error.code === 'agentcard_company_transfer_consumed_during_reclaim'
    );
    assert.equal(provider.reclaimCalls.length, 0);
    // With allowConsumed the reclaim proceeds.
    await reclaimPurchaseWalletFunding(purchase, 'voided', provider, { allowConsumed: true });
    assert.equal(provider.reclaimCalls.length, 1);
    const funding = await findWalletFundingByPurchaseId(purchase.id);
    assert.equal(funding?.status, PurchaseWalletFundingStatus.RECLAIMED);
  });

  await test('reclaim marks RECLAIM_FAILED on a generic provider error', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    await recordPurchaseWalletFunding(purchase, 'usd', 'owt_fail', {});
    const provider = new ThrowingReclaimProvider(new Error('mcp exploded'));
    await assert.rejects(
      () => reclaimPurchaseWalletFunding(purchase, 'reason', provider),
      /mcp exploded/
    );
    const funding = await findWalletFundingByPurchaseId(purchase.id);
    assert.equal(funding?.status, PurchaseWalletFundingStatus.RECLAIM_FAILED);
    assert.equal(funding?.errorMessage, 'mcp exploded');
  });

  await test('reclaim rethrows release-pending without marking RECLAIM_FAILED', async () => {
    const userId = await seedUser();
    const purchase = await seedPurchase(userId);
    await recordPurchaseWalletFunding(purchase, 'usd', 'owt_pending', {});
    const provider = new ThrowingReclaimProvider(
      new WalletFundingProviderError(
        'still releasing',
        409,
        'agentcard_company_transfer_release_pending'
      )
    );
    await assert.rejects(
      () => reclaimPurchaseWalletFunding(purchase, 'reason', provider),
      (error: unknown) =>
        error instanceof WalletFundingProviderError &&
        error.code === 'agentcard_company_transfer_release_pending'
    );
    const funding = await findWalletFundingByPurchaseId(purchase.id);
    assert.equal(
      funding?.status,
      PurchaseWalletFundingStatus.RECLAIMING,
      'release-pending leaves the row RECLAIMING for a retry'
    );
  });

  process.stdout.write(
    `\nPurchase wallet-funding unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

main()
  .then(async () => {
    await cleanup();
    if (failures.length > 0) process.exit(1);
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await cleanup();
    process.exit(1);
  });
