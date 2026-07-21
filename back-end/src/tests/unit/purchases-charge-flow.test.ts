#!/usr/bin/env tsx
/**
 * Unit tests for the purchase charge/issue flow (`domains/purchases/charge.ts`)
 * and the company-flow card mint retry (`domains/purchases/companyFlowCard.ts`),
 * driven through `mintPurchaseCard` with injected card + wallet providers and a
 * stubbed Stripe against the live local Postgres.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { mintPurchaseCard, PurchaseError } from '../../domains/purchases/service';
import type { MintPurchaseInput } from '../../domains/purchases/types';
import {
  FailingDetailsCardProvider,
  FakeCardProvider,
  FakeWalletFundingProvider,
  FundingInProgressCardProvider,
  withFakeStripe,
} from '../blackbox/purchases.testkit';
import { ROSE_AGENT_CARD_ID } from '../../providers/card-provider/static-card';

// Test-only Rose Agent Card credentials, injected via env (never a real card).
const STATIC_CARD_ENV = {
  ROSE_AGENT_CARD_PAN: '4111111111111111',
  ROSE_AGENT_CARD_CVV: '321',
  ROSE_AGENT_CARD_EXPIRY: '11/30',
  ROSE_AGENT_CARD_PIN: '4242',
};

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

async function seedSubscribedUser(): Promise<string> {
  const userId = `charge-flow-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeCustomerId: `cus_${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  createdUserIds.push(userId);
  return userId;
}

function mintInput(userId: string, overrides: Partial<MintPurchaseInput> = {}): MintPurchaseInput {
  return {
    userId,
    agentId: undefined,
    fingerprint: `fp-${randomUUID()}`,
    merchant: 'Charge Flow Merchant',
    currency: 'USD',
    lineItems: [{ label: 'Widget', amountCents: 1000 }],
    fees: [{ label: 'Tax', amountCents: 80 }],
    subtotalCents: 1000,
    totalCents: 1080,
    ...overrides,
  } as MintPurchaseInput;
}

async function latestStatus(
  userId: string,
  fingerprint: string
): Promise<PurchaseSpendStatus | undefined> {
  const row = await prisma.purchaseSpend.findFirst({
    where: { userId, fingerprint },
    orderBy: { createdAt: 'desc' },
  });
  return row?.status;
}

async function main(): Promise<void> {
  process.stdout.write('Running purchases charge-flow unit tests...\n');

  await test('mintPurchaseCard authorizes, funds, captures, and holds the card', async () => {
    const userId = await seedSubscribedUser();
    const provider = new FakeCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    const result = await withFakeStripe(async (calls) => {
      const outcome = await mintPurchaseCard(input, provider, wallet);
      assert.equal(calls.charges.length, 1, 'one manual-capture hold');
      assert.equal(calls.captures.length, 1, 'the hold is captured after funding');
      return outcome;
    });
    assert.equal(result.status, PurchaseSpendStatus.HELD);
    assert.equal(result.cardId, provider.cardId);
    assert.equal(result.pan, provider.pan);
    assert.equal(await latestStatus(userId, input.fingerprint), PurchaseSpendStatus.HELD);
  });

  await test('mintPurchaseCard rolls back and refunds when card details fail', async () => {
    const userId = await seedSubscribedUser();
    const provider = new FailingDetailsCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    await withFakeStripe(async (calls) => {
      await assert.rejects(() => mintPurchaseCard(input, provider, wallet), /card details failed/);
      assert.equal(calls.captures.length, 1, 'capture happened before details failed');
      assert.equal(calls.refunds.length, 1, 'the captured charge is refunded on rollback');
    });
    assert.equal(provider.closeCalls, 1, 'the issued card is closed on failure');
    assert.equal(wallet.reclaimCalls.length, 1, 'the funding is reclaimed on failure');
    assert.equal(await latestStatus(userId, input.fingerprint), PurchaseSpendStatus.FAILED);
  });

  await test('mintPurchaseCard waits out AgentCard company funding-in-progress', async () => {
    const userId = await seedSubscribedUser();
    const provider = new FundingInProgressCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    const result = await withFakeStripe(async () => mintPurchaseCard(input, provider, wallet));
    assert.equal(result.status, PurchaseSpendStatus.HELD);
    assert.equal(
      wallet.confirmCalls.length,
      1,
      'the settling company transfer is confirmed before the card mints'
    );
    assert.equal(provider.mintCalls, 2, 'mint retried after the funding-in-progress signal');
  });

  await test('mintPurchaseCard validates its inputs before touching Stripe', async () => {
    const userId = await seedSubscribedUser();
    await assert.rejects(
      () => mintPurchaseCard(mintInput('   ')),
      (error: unknown) => error instanceof PurchaseError && error.statusCode === 401
    );
    await assert.rejects(
      () => mintPurchaseCard(mintInput(userId, { merchant: '  ' })),
      /merchant is required/
    );
    await assert.rejects(
      () => mintPurchaseCard(mintInput(userId, { totalCents: 0 })),
      /totalCents must be a positive integer/
    );
    await assert.rejects(
      () => mintPurchaseCard(mintInput(userId, { currency: 'eur' })),
      /Only USD purchases/
    );
    await assert.rejects(
      () => mintPurchaseCard(mintInput(userId, { totalCents: 5_000_000 })),
      (error: unknown) => error instanceof PurchaseError && error.statusCode === 402
    );
  });

  await test('AGENTCARD MINT CUTOFF: real charge flow hands back the static Brex card (no injected provider)', async () => {
    const userId = await seedSubscribedUser();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId, { totalCents: 4396 });
    // Cutoff active: flag + benchmark mode OFF (benchmark mode force-enables real minting), and the
    // card credentials injected via env (never hardcoded).
    const envKeys = [
      'AGENTCARD_MINT_ENABLED',
      'BENCHMARK_MODE',
      'BENCHMARK_ISOLATED_RUN',
      ...Object.keys(STATIC_CARD_ENV),
    ];
    const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    delete process.env.AGENTCARD_MINT_ENABLED;
    delete process.env.BENCHMARK_MODE;
    delete process.env.BENCHMARK_ISOLATED_RUN;
    Object.assign(process.env, STATIC_CARD_ENV);
    try {
      const result = await withFakeStripe(async (calls) => {
        // NO card provider injected -> service resolves the REAL createCardProvider(), which
        // under the cutoff returns the static Rose Agent Card, exercising the full mint path.
        const outcome = await mintPurchaseCard(input, undefined, wallet);
        // The user's Stripe hold is STILL captured under the cutoff (only the mint side changes).
        assert.equal(calls.charges.length, 1, 'one manual-capture hold');
        assert.equal(calls.captures.length, 1, 'the hold is captured');
        return outcome;
      });
      assert.equal(result.status, PurchaseSpendStatus.HELD);
      assert.equal(result.cardId, ROSE_AGENT_CARD_ID, 'static card id');
      assert.equal(
        result.pan,
        STATIC_CARD_ENV.ROSE_AGENT_CARD_PAN,
        'injected PAN reaches the caller'
      );
      assert.equal(
        result.cvv,
        STATIC_CARD_ENV.ROSE_AGENT_CARD_CVV,
        'injected CVV reaches the caller'
      );
      assert.equal(result.expiry, STATIC_CARD_ENV.ROSE_AGENT_CARD_EXPIRY, 'injected expiry');
      assert.equal(
        result.last4,
        STATIC_CARD_ENV.ROSE_AGENT_CARD_PAN.slice(-4),
        'last4 = injected PAN tail'
      );
      assert.equal(await latestStatus(userId, input.fingerprint), PurchaseSpendStatus.HELD);
      assert.equal(wallet.reclaimCalls.length, 0, 'static mint does not fail/roll back');
      // The static card is company-funded out-of-band: NO AgentCard wallet-funding row is recorded
      // (a fabricated transfer would otherwise be reclaimed against a nonexistent object).
      const funding = await prisma.purchaseWalletFunding.findUnique({
        where: { purchaseId: result.purchaseId },
      });
      assert.equal(funding, null, 'no wallet funding recorded for the static company card');
    } finally {
      for (const [name, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  process.stdout.write(
    `\nPurchases charge-flow unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.subscription.deleteMany({ where: { userId } });
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
