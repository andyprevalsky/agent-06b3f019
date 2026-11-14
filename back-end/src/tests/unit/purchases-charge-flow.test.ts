#!/usr/bin/env tsx
/**
 * Unit tests for the purchase charge/issue flow (`domains/purchases/charge.ts`)
 * and the company-flow card mint retry (`domains/purchases/companyFlowCard.ts`),
 * driven through `mintPurchaseCard` with injected card + wallet providers and a
 * stubbed Stripe against the live local Postgres.
 */

import assert from 'node:assert/strict';
import { assertAmbiguousFundingRetryKeepsObligation } from './purchase-funding-prior-obligation.cases';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { MAX_PURCHASE_CENTS, PURCHASE_ABOVE_MAX_LIMIT_CODE } from '../../domains/purchases/config';
import { lookupPurchase, mintPurchaseCard, PurchaseError } from '../../domains/purchases/service';
import type { MintPurchaseInput } from '../../domains/purchases/types';
import {
  AgentCardProviderError,
  AgentCardRoutingProvider,
  type CardProviderMintRequest,
  createCardProviderForAgent,
  StaticRoseAgentCardProvider,
} from '../../providers/card-provider';
import {
  FailingDetailsCardProvider,
  FakeCardProvider,
  FakeWalletFundingProvider,
  FundingInProgressCardProvider,
  StubCardStateProvider,
  withFakeStripe,
} from '../blackbox/purchases.testkit';
import { ROSE_AGENT_CARD_ID } from '../../providers/card-provider/static-card';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

class TransferlessFundingInProgressCardProvider extends FakeCardProvider {
  private returnedFundingGate = false;

  async mintCard(request: CardProviderMintRequest) {
    if (!this.returnedFundingGate) {
      this.returnedFundingGate = true;
      this.mintCalls += 1;
      this.mintRequests.push(request);
      throw new AgentCardProviderError(
        'AgentCard company funding is in progress',
        409,
        undefined,
        'agentcard_company_funding_in_progress',
        {
          agentcardStatus: 'funding_in_progress',
          retryAfterSeconds: 0,
        }
      );
    }
    return super.mintCard(request);
  }
}

/** Org-style mint: secrets already resolved during mintCard — charge must not re-getDetails. */
class MintWithSecretsCardProvider extends FakeCardProvider {
  async mintCard(request: CardProviderMintRequest) {
    const minted = await super.mintCard(request);
    return {
      ...minted,
      pan: this.pan,
      cvv: this.cvv,
      balanceCents: request.amountCents,
    };
  }

  async getDetails(cardId: string) {
    this.detailCalls += 1;
    throw new Error(`getDetails must not run when mint returned secrets (card=${cardId})`);
  }
}

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
  assertAmbiguousFundingRetryKeepsObligation(path.resolve(__dirname, '../../..'));

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

  await test('mintPurchaseCard reuses mint secrets and skips a second getDetails', async () => {
    const userId = await seedSubscribedUser();
    const provider = new MintWithSecretsCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    const result = await withFakeStripe(async () => mintPurchaseCard(input, provider, wallet));
    assert.equal(result.status, PurchaseSpendStatus.HELD);
    assert.equal(result.pan, provider.pan);
    assert.equal(provider.detailCalls, 0, 'mint-provided secrets must not trigger getDetails');
  });

  await test('mintPurchaseCard reclaims and cancels when pre-capture card details fail', async () => {
    const userId = await seedSubscribedUser();
    const provider = new FailingDetailsCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    await withFakeStripe(async (calls) => {
      await assert.rejects(() => mintPurchaseCard(input, provider, wallet), /card details failed/);
      assert.equal(calls.captures.length, 0, 'card details are verified before capture');
      assert.equal(calls.cancels.length, 1, 'the uncaptured hold is canceled on rollback');
      assert.equal(calls.refunds.length, 0, 'an uncaptured hold must never be refunded');
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

  await test('mintPurchaseCard retries transferless AgentCard funding-in-progress', async () => {
    const userId = await seedSubscribedUser();
    const provider = new TransferlessFundingInProgressCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    const result = await withFakeStripe(async () => mintPurchaseCard(input, provider, wallet));
    assert.equal(result.status, PurchaseSpendStatus.HELD);
    assert.equal(provider.mintCalls, 2, 'mint retried after transferless funding signal');
    assert.equal(
      wallet.confirmCalls.length,
      0,
      'no transfer is confirmed until AgentCard returns a concrete transfer id'
    );
  });

  await test('mintPurchaseCard verifies an ambiguous capture response before returning the card', async () => {
    const userId = await seedSubscribedUser();
    const provider = new FakeCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    const result = await withFakeStripe(
      async (calls) => {
        const outcome = await mintPurchaseCard(input, provider, wallet);
        assert.equal(calls.captures.length, 1);
        assert.equal(calls.retrieves.length, 1, 'ambiguous capture must be verified at Stripe');
        assert.equal(calls.cancels.length, 0);
        assert.equal(calls.refunds.length, 0);
        return outcome;
      },
      { captureError: new Error('capture response was lost') }
    );
    assert.equal(result.status, PurchaseSpendStatus.HELD);
  });

  await test('mintPurchaseCard never returns a card for a canceled PaymentIntent', async () => {
    const userId = await seedSubscribedUser();
    const provider = new FakeCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    const terminalError = Object.assign(new Error('PaymentIntent is already canceled'), {
      code: 'payment_intent_unexpected_state',
    });
    await withFakeStripe(
      async (calls) => {
        await assert.rejects(() => mintPurchaseCard(input, provider, wallet), terminalError);
        assert.equal(calls.captures.length, 1);
        assert.equal(calls.cancels.length, 0);
        assert.equal(calls.refunds.length, 0);
      },
      {
        captureError: terminalError,
        retrievePaymentIntent: (id) => ({
          id,
          status: 'canceled',
          amount_capturable: 0,
          amount_received: 0,
        }),
      }
    );
    assert.equal(provider.closeCalls, 1);
    assert.equal(wallet.reclaimCalls.length, 1);
    assert.equal(await latestStatus(userId, input.fingerprint), PurchaseSpendStatus.FAILED);
  });

  await test('mintPurchaseCard recovers a committed card when the DB acknowledgement is lost', async () => {
    const userId = await seedSubscribedUser();
    const provider = new FakeCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId);
    const transactionDelegate = prisma as unknown as {
      $transaction: (...args: unknown[]) => Promise<unknown>;
    };
    const originalTransaction = transactionDelegate.$transaction.bind(prisma);
    const originalMint = provider.mintCard.bind(provider);
    provider.mintCard = async (request) => {
      const result = await originalMint(request);
      transactionDelegate.$transaction = async (...args) => {
        transactionDelegate.$transaction = originalTransaction;
        await originalTransaction(...args);
        throw new Error('database commit acknowledgement was lost');
      };
      return result;
    };
    try {
      await withFakeStripe(async (calls) => {
        await assert.rejects(
          () => mintPurchaseCard(input, provider, wallet),
          /database commit acknowledgement was lost/
        );
        assert.equal(calls.captures.length, 0);
        assert.equal(calls.cancels.length, 1);
      });
    } finally {
      transactionDelegate.$transaction = originalTransaction;
    }
    assert.equal(provider.closeCalls, 1, 'durably persisted card must be closed');
    assert.equal(wallet.reclaimCalls.length, 1, 'durably persisted transfer must be reclaimed');
    assert.equal(await latestStatus(userId, input.fingerprint), PurchaseSpendStatus.FAILED);
  });

  await test('mintPurchaseCard does not reuse another agent HELD fingerprint', async () => {
    const userId = await seedSubscribedUser();
    const fingerprint = `fp-${randomUUID()}`;
    const orphanAgent = await prisma.agent.create({
      data: { userId, goal: 'orphaned held purchase agent' },
    });
    const nextAgent = await prisma.agent.create({
      data: { userId, goal: 'fresh mint agent' },
    });
    const orphan = await prisma.purchaseSpend.create({
      data: {
        userId,
        agentId: orphanAgent.id,
        fingerprint,
        canonicalFingerprint: fingerprint,
        merchant: 'Rose Labs Test Payment',
        lineItemsJson: {
          fees: [],
          currency: 'USD',
          lineItems: [{ name: 'Agent Card Lifecycle Probe', quantity: 1, unitPriceCents: 100 }],
          totalCents: 100,
          subtotalCents: 100,
        },
        totalCents: 100,
        status: PurchaseSpendStatus.HELD,
        cardId: `card-${randomUUID()}`,
        provider: 'agentcard',
      },
    });
    const provider = new FakeCardProvider();
    const wallet = new FakeWalletFundingProvider();
    const input = mintInput(userId, {
      agentId: nextAgent.id,
      fingerprint,
      merchant: 'Rose Labs Test Payment',
      lineItems: [{ label: 'Agent Card Lifecycle Probe', amountCents: 100 }],
      fees: [],
      subtotalCents: 100,
      totalCents: 100,
    });
    const result = await withFakeStripe(async () => mintPurchaseCard(input, provider, wallet));
    assert.notEqual(result.purchaseId, orphan.id, 'must open a fresh purchase for the new agent');
    assert.equal(result.status, PurchaseSpendStatus.HELD);
    const nextPurchase = await prisma.purchaseSpend.findUnique({
      where: { id: result.purchaseId },
    });
    assert.equal(nextPurchase?.agentId, nextAgent.id);
    assert.equal(
      (await prisma.purchaseSpend.findUnique({ where: { id: orphan.id } }))?.status,
      PurchaseSpendStatus.HELD,
      'orphan HELD row must remain untouched'
    );
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
      () => mintPurchaseCard(mintInput(userId, { totalCents: MAX_PURCHASE_CENTS + 1 })),
      (error: unknown) =>
        error instanceof PurchaseError &&
        error.statusCode === 400 &&
        error.code === PURCHASE_ABOVE_MAX_LIMIT_CODE &&
        error.message === `Purchase is above max limit of ${MAX_PURCHASE_CENTS}`
    );
  });

  await test('lookupPurchase preserves a held card when benchmark routing lookup fails', async () => {
    const userId = await seedSubscribedUser();
    const agent = await prisma.agent.create({
      data: { userId, goal: 'benchmark routing failure boundary' },
    });
    const fingerprint = `fp-${randomUUID()}`;
    const purchase = await prisma.purchaseSpend.create({
      data: {
        userId,
        agentId: agent.id,
        fingerprint,
        merchant: 'Routing Failure Merchant',
        lineItemsJson: { totalCents: 1080 },
        totalCents: 1080,
        status: PurchaseSpendStatus.HELD,
        cardId: `card-${randomUUID()}`,
      },
    });
    const agentDelegate = prisma.agent as unknown as {
      findUnique: typeof prisma.agent.findUnique;
    };
    const originalFindUnique = agentDelegate.findUnique;
    agentDelegate.findUnique = (async () => {
      throw new Error('benchmark lookup unavailable');
    }) as typeof prisma.agent.findUnique;
    try {
      await assert.rejects(
        () => lookupPurchase(userId, fingerprint),
        /benchmark lookup unavailable/
      );
    } finally {
      agentDelegate.findUnique = originalFindUnique;
    }
    assert.equal(await latestStatus(userId, fingerprint), PurchaseSpendStatus.HELD);
    assert.equal(
      (await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } }))?.status,
      PurchaseSpendStatus.HELD
    );
  });

  await test('lookupPurchase does not mark CLEARED a held card closed for reclaim', async () => {
    const userId = await seedSubscribedUser();
    const agent = await prisma.agent.create({
      data: { userId, goal: 'abandon reclaim race boundary' },
    });
    const fingerprint = `fp-${randomUUID()}`;
    const cardId = `card-${randomUUID()}`;
    const purchase = await prisma.purchaseSpend.create({
      data: {
        userId,
        agentId: agent.id,
        fingerprint,
        merchant: 'Abandon Race Merchant',
        lineItemsJson: { totalCents: 4396 },
        totalCents: 4396,
        status: PurchaseSpendStatus.HELD,
        cardId,
        stripePaymentIntentId: `pi_${randomUUID()}`,
      },
    });
    await prisma.purchaseWalletFunding.create({
      data: {
        purchaseId: purchase.id,
        userId,
        amountCents: 4396,
        currency: 'usd',
        status: PurchaseWalletFundingStatus.RECLAIMING,
        providerTransferId: `owt_${randomUUID()}`,
        idempotencyKey: `purchase-wallet-fund:${purchase.id}`,
      },
    });
    const provider = new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 });
    const result = await lookupPurchase(userId, fingerprint, provider);
    assert.equal(result.found, true);
    assert.equal(result.reusable, false);
    assert.equal(result.purchase?.status, PurchaseSpendStatus.HELD);
    assert.equal(
      (await prisma.purchaseSpend.findUnique({ where: { id: purchase.id } }))?.status,
      PurchaseSpendStatus.HELD,
      'closed card mid-reclaim must not be marked CLEARED'
    );
  });

  await test('durable benchmark agents bypass the static-card cutoff request by request', async () => {
    const userId = await seedSubscribedUser();
    const benchmarkAgent = await prisma.agent.create({
      data: { userId, goal: 'benchmark provider routing', isBenchmark: true },
    });
    const ordinaryAgent = await prisma.agent.create({
      data: { userId, goal: 'ordinary provider routing' },
    });
    const envKeys = ['AGENTCARD_MINT_ENABLED', 'BENCHMARK_MODE', 'BENCHMARK_ISOLATED_RUN'];
    const prevEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    try {
      assert.ok(
        (await createCardProviderForAgent(userId, benchmarkAgent.id)) instanceof
          AgentCardRoutingProvider,
        'the persisted benchmark bit selects live AgentCard minting'
      );
      assert.ok(
        (await createCardProviderForAgent(userId, ordinaryAgent.id)) instanceof
          StaticRoseAgentCardProvider,
        'an ordinary agent in the same process remains on the static card'
      );
    } finally {
      for (const [name, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
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

  await test('redacts pan/cvv from mint archive payload', async () => {
    const { mintResponseForArchive } = await import('../../domains/purchases/chargeHelpers');
    const safe = mintResponseForArchive({
      cardId: 'card-archive',
      last4: '1111',
      expiry: '12/30',
      spendLimitCents: 1000,
      status: 'ACTIVE',
      pan: '4111111111111111',
      cvv: '123',
      balanceCents: 1000,
    });
    assert.equal('pan' in safe, false);
    assert.equal('cvv' in safe, false);
    assert.equal(safe.cardId, 'card-archive');
    const chargePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../domains/purchases/charge.ts'
    );
    const source = readFileSync(chargePath, 'utf8');
    assert.match(source, /mint_response:\s*mintResponseForArchive\(minted\)/);
  });

  process.stdout.write(
    `\nPurchases charge-flow unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.purchaseWalletFunding.deleteMany({ where: { userId } });
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
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
