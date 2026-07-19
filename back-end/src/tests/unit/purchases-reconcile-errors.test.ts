#!/usr/bin/env tsx
/**
 * Unit tests for the purchases boundary helpers and reconciliation paths:
 *  - `errors.ts`  — typed boundary mapping + company-funding detail extraction.
 *  - `kyc.ts`     — KYC-required error classification.
 *  - `reconcile.ts` — webhook signature verification, closePurchaseCard, and the
 *                     AgentCard transaction webhook (cleared/voided) reconciliation.
 *
 * Card + wallet providers are injected and Stripe is stubbed; the reconcile module
 * is imported dynamically after seeding a webhook secret so the signature branches
 * are reachable.
 */

import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { AgentCardProviderError } from '../../providers/card-provider';
import { WalletFundingProviderError } from '../../providers/wallet-funding';
import {
  PurchaseError,
  companyFundingInProgressDetails,
  toPurchaseBoundaryError,
} from '../../domains/purchases/errors';
import {
  isKycRequiredError,
  kycRequiredPurchaseError,
  KYC_REQUIRED_CODE,
} from '../../domains/purchases/kyc';
import {
  StubCardStateProvider,
  FakeWalletFundingProvider,
  withFakeStripe,
} from '../blackbox/purchases.testkit';

const WEBHOOK_SECRET = `whsec_${randomUUID()}`;
process.env.AGENTCARD_WEBHOOK_SECRET = WEBHOOK_SECRET;

const createdUserIds: string[] = [];
let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

async function seedUser(): Promise<string> {
  const userId = `reconcile-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

async function seedPurchase(
  userId: string,
  cardId: string,
  status: PurchaseSpendStatus
): Promise<string> {
  const row = await prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint: `fp-${randomUUID()}`,
      merchant: 'Reconcile Merchant',
      lineItemsJson: { totalCents: 1080 },
      totalCents: 1080,
      status,
      cardId,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });
  return row.id;
}

async function statusOf(id: string): Promise<PurchaseSpendStatus | undefined> {
  return (await prisma.purchaseSpend.findUnique({ where: { id } }))?.status;
}

function signPayload(payload: unknown, timestamp = Math.floor(Date.now() / 1000)): string {
  const raw = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function main(): Promise<void> {
  process.stdout.write('Running purchases reconcile/errors unit tests...\n');
  const reconcile = await import('../../domains/purchases/reconcile');

  // ── errors.ts ──
  await test('toPurchaseBoundaryError maps every provider error shape', () => {
    const purchaseError = new PurchaseError('boom', 409);
    assert.equal(toPurchaseBoundaryError(purchaseError), purchaseError);

    const missingCustomer = toPurchaseBoundaryError({
      code: 'resource_missing',
      param: 'customer',
    });
    assert.ok(missingCustomer instanceof PurchaseError);
    assert.equal((missingCustomer as PurchaseError).statusCode, 402);

    const agentcard4xx = toPurchaseBoundaryError(
      new AgentCardProviderError('nope', 409, undefined, 'x')
    );
    assert.equal((agentcard4xx as PurchaseError).statusCode, 409);
    const agentcard5xx = toPurchaseBoundaryError(new AgentCardProviderError('nope', 500));
    assert.equal((agentcard5xx as PurchaseError).statusCode, 502);

    const walletError = toPurchaseBoundaryError(new WalletFundingProviderError('w', 409, 'code'));
    assert.equal((walletError as PurchaseError).statusCode, 409);

    const generic = toPurchaseBoundaryError(new Error('plain'));
    assert.ok(generic instanceof Error && !(generic instanceof PurchaseError));
    assert.equal(toPurchaseBoundaryError('string-thrown').message, 'string-thrown');
  });

  await test('companyFundingInProgressDetails extracts transfer details', () => {
    assert.equal(companyFundingInProgressDetails(new Error('no')), undefined);
    assert.equal(
      companyFundingInProgressDetails(new AgentCardProviderError('x', 409, undefined, 'other')),
      undefined
    );
    assert.equal(
      companyFundingInProgressDetails(
        new AgentCardProviderError('x', 409, undefined, 'agentcard_company_funding_in_progress', {})
      ),
      undefined,
      'missing transfer id yields undefined'
    );
    const details = companyFundingInProgressDetails(
      new AgentCardProviderError('x', 409, undefined, 'agentcard_company_funding_in_progress', {
        transferId: 'owt_1',
        retryAfterSeconds: 3,
        agentcardResult: { ok: true },
      })
    );
    assert.equal(details?.transferId, 'owt_1');
    assert.equal(details?.retryAfterSeconds, 3);
    assert.deepEqual(details?.agentcardResult, { ok: true });
  });

  // ── kyc.ts ──
  await test('isKycRequiredError classifies KYC signals and rejects others', () => {
    assert.equal(
      isKycRequiredError(new AgentCardProviderError('customer kyc_required', 422)),
      true
    );
    assert.equal(
      isKycRequiredError(new AgentCardProviderError('cardholder-kyc-required', 403)),
      true
    );
    assert.equal(
      isKycRequiredError(new AgentCardProviderError('kyc_required', 500)),
      false,
      'non-4xx status is not KYC'
    );
    assert.equal(isKycRequiredError(new Error('totally unrelated')), false);
    const purchaseError = kycRequiredPurchaseError();
    assert.equal(purchaseError.statusCode, 422);
    assert.equal(purchaseError.code, KYC_REQUIRED_CODE);
  });

  // ── reconcile.ts: webhook signature ──
  await test('verifyAgentCardWebhookSignature accepts a valid signature', () => {
    const payload = { type: 'transaction.cleared', cardId: 'card-1' };
    reconcile.verifyAgentCardWebhookSignature(JSON.stringify(payload), signPayload(payload));
  });

  await test('verifyAgentCardWebhookSignature rejects missing/malformed/expired/invalid', () => {
    const payload = { type: 'transaction.cleared' };
    const raw = JSON.stringify(payload);
    assert.throws(
      () => reconcile.verifyAgentCardWebhookSignature(raw),
      /Missing AgentCard webhook signature/
    );
    assert.throws(() => reconcile.verifyAgentCardWebhookSignature(raw, 'garbage'), /Malformed/);
    assert.throws(
      () => reconcile.verifyAgentCardWebhookSignature(raw, signPayload(payload, 1)),
      /outside tolerance/
    );
    const tampered = signPayload(payload).replace(/v1=[0-9a-f]+/, 'v1=deadbeef');
    assert.throws(
      () => reconcile.verifyAgentCardWebhookSignature(raw, tampered),
      /Invalid|Malformed/
    );
  });

  // ── reconcile.ts: closePurchaseCard ──
  await test('closePurchaseCard validates card id and missing purchase', async () => {
    await assert.rejects(() => reconcile.closePurchaseCard(''), /cardId is required/);
    await assert.rejects(
      () => reconcile.closePurchaseCard(`missing-${randomUUID()}`),
      (error: unknown) => error instanceof PurchaseError && error.statusCode === 404
    );
  });

  await test('closePurchaseCard is idempotent for terminal purchases', async () => {
    const userId = await seedUser();
    const cardId = `card-${randomUUID()}`;
    await seedPurchase(userId, cardId, PurchaseSpendStatus.VOIDED);
    const result = await reconcile.closePurchaseCard(
      cardId,
      new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 })
    );
    assert.equal(result.status, PurchaseSpendStatus.VOIDED);
  });

  await test('closePurchaseCard closes a CLEARED card without reclaiming', async () => {
    const userId = await seedUser();
    const cardId = `card-${randomUUID()}`;
    await seedPurchase(userId, cardId, PurchaseSpendStatus.CLEARED);
    const result = await reconcile.closePurchaseCard(
      cardId,
      new StubCardStateProvider({ status: 'CLOSED', balanceCents: 0 })
    );
    assert.equal(result.status, PurchaseSpendStatus.CLEARED);
  });

  await test('closePurchaseCard voids an unspent HELD card and refunds', async () => {
    const userId = await seedUser();
    const cardId = `card-${randomUUID()}`;
    const purchaseId = await seedPurchase(userId, cardId, PurchaseSpendStatus.HELD);
    const result = await withFakeStripe(async (calls) => {
      const outcome = await reconcile.closePurchaseCard(
        cardId,
        new StubCardStateProvider({ status: 'OPEN', balanceCents: 1080 }),
        new FakeWalletFundingProvider()
      );
      assert.equal(calls.refunds.length, 1);
      return outcome;
    });
    assert.equal(result.status, PurchaseSpendStatus.VOIDED);
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
  });

  // ── reconcile.ts: handleAgentCardWebhook ──
  await test('handleAgentCardWebhook ignores events without a known card', async () => {
    assert.deepEqual(await reconcile.handleAgentCardWebhook({ type: 'transaction.cleared' }), {
      ok: true,
    });
    assert.deepEqual(
      await reconcile.handleAgentCardWebhook({
        type: 'transaction.cleared',
        cardId: `unknown-${randomUUID()}`,
      }),
      { ok: true }
    );
  });

  await test('handleAgentCardWebhook clears a purchase on transaction.cleared', async () => {
    const userId = await seedUser();
    const cardId = `card-${randomUUID()}`;
    const purchaseId = await seedPurchase(userId, cardId, PurchaseSpendStatus.HELD);
    await reconcile.handleAgentCardWebhook({
      type: 'transaction.cleared',
      data: { card: { id: cardId } },
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.CLEARED);
  });

  await test(
    'handleAgentCardWebhook does not clobber a reclaimed purchase with a late transaction.cleared',
    async () => {
      const userId = await seedUser();
      const cardId = `card-${randomUUID()}`;
      // The abandon flow marks funding RECLAIMED before flipping the purchase to
      // VOIDED. A late/duplicate transaction.cleared that raced the abandon
      // (read the row while still HELD) must NOT settle the purchase to CLEARED,
      // or it ends up CLEARED while the funding is already reclaimed + refunded.
      const purchaseId = await seedPurchase(userId, cardId, PurchaseSpendStatus.HELD);
      await prisma.purchaseWalletFunding.create({
        data: {
          purchaseId,
          userId,
          amountCents: 1080,
          status: PurchaseWalletFundingStatus.RECLAIMED,
          idempotencyKey: `idem-${randomUUID()}`,
        },
      });
      await reconcile.handleAgentCardWebhook({
        type: 'transaction.cleared',
        data: { card: { id: cardId } },
      });
      assert.notEqual(await statusOf(purchaseId), PurchaseSpendStatus.CLEARED);
    }
  );

  await test('handleAgentCardWebhook voids a HELD purchase on transaction.voided', async () => {
    const userId = await seedUser();
    const cardId = `card-${randomUUID()}`;
    const purchaseId = await seedPurchase(userId, cardId, PurchaseSpendStatus.HELD);
    await withFakeStripe(async (calls) => {
      await reconcile.handleAgentCardWebhook({ type: 'transaction.voided', cardId });
      assert.equal(calls.refunds.length, 1);
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.VOIDED);
  });

  await test('handleAgentCardWebhook refunds a CLEARED purchase on transaction.voided', async () => {
    const userId = await seedUser();
    const cardId = `card-${randomUUID()}`;
    const purchaseId = await seedPurchase(userId, cardId, PurchaseSpendStatus.CLEARED);
    await withFakeStripe(async (calls) => {
      await reconcile.handleAgentCardWebhook({ type: 'transaction.voided', cardId });
      assert.equal(calls.refunds.length, 1);
    });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.REFUNDED);
  });

  await test('handleAgentCardWebhook never resurrects a terminal purchase', async () => {
    const userId = await seedUser();
    const cardId = `card-${randomUUID()}`;
    const purchaseId = await seedPurchase(userId, cardId, PurchaseSpendStatus.REFUNDED);
    await reconcile.handleAgentCardWebhook({ type: 'transaction.voided', cardId });
    assert.equal(await statusOf(purchaseId), PurchaseSpendStatus.REFUNDED);
  });

  process.stdout.write(
    `\nPurchases reconcile/errors unit tests: ${passed} passed, ${failures.length} failed\n`
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
