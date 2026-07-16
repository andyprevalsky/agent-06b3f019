#!/usr/bin/env tsx
/**
 * Unit tests for the benchmark test-payment domain: catalog validation/totals
 * (`catalog.ts`), the lifecycle cross-check assembler (`lifecycle.ts`), and the
 * service layer (`service.ts`) — sandbox settlement, Stripe confirmation, phone
 * benchmark payment + audit, and the benchmark AgentCard setup toggles.
 *
 * Stripe is stubbed and every external dependency is injected, so no network or
 * MCP call is made; the AgentCard-setup + audit paths hit the live local Postgres
 * and a temp audit file.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { stripe } from '../../providers/stripe';
import {
  assertCardPresent,
  calculateTotals,
  getTestPaymentCatalog,
  isAgentCardSandboxPan,
  normalizeExpiry,
  normalizeLineItems,
  paymentMethodIdForBenchmarkCard,
} from '../../domains/test-payment/catalog';
import { getTestPaymentLifecycle } from '../../domains/test-payment/lifecycle';
import {
  abandonTestPayment,
  configureBenchmarkAgentCardSetup,
  confirmPhoneBenchmarkPayment,
  confirmTestPayment,
  recordPhoneBenchmarkPaymentAudit,
  resolvePublicBaseUrl,
  TestPaymentError,
} from '../../domains/test-payment/service';

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

async function seedUser(): Promise<string> {
  const userId = `test-payment-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  createdUserIds.push(userId);
  return userId;
}

function threeItems(): Array<{ id: string; quantity: number }> {
  return [
    { id: 'aurora-notebook', quantity: 1 },
    { id: 'copper-pen', quantity: 1 },
    { id: 'ceramic-mug', quantity: 1 },
  ];
}

async function withStubbedStripe<T>(fn: () => Promise<T>): Promise<T> {
  const paymentMethods = stripe.paymentMethods as unknown as {
    create: (params: unknown) => Promise<{ id: string }>;
  };
  const paymentIntents = stripe.paymentIntents as unknown as {
    create: (params: unknown) => Promise<{ id: string; status: string }>;
  };
  const originalPm = paymentMethods.create;
  const originalPi = paymentIntents.create;
  paymentMethods.create = async () => ({ id: `pm_${randomUUID()}` });
  paymentIntents.create = async () => ({ id: `pi_${randomUUID()}`, status: 'succeeded' });
  try {
    return await fn();
  } finally {
    paymentMethods.create = originalPm;
    paymentIntents.create = originalPi;
  }
}

async function main(): Promise<void> {
  process.stdout.write('Running test-payment service unit tests...\n');

  // ── catalog ──
  await test('normalizeLineItems validates count, duplicates, ids, and quantity', () => {
    const normalized = normalizeLineItems(threeItems());
    assert.equal(normalized.length, 3);
    assert.equal(normalized[0].unitPriceCents, 1200);
    assert.throws(
      () => normalizeLineItems([{ id: 'aurora-notebook', quantity: 1 }]),
      TestPaymentError
    );
    assert.throws(
      () =>
        normalizeLineItems([
          { id: 'aurora-notebook', quantity: 1 },
          { id: 'aurora-notebook', quantity: 1 },
          { id: 'copper-pen', quantity: 1 },
        ]),
      /duplicate/
    );
    assert.throws(
      () =>
        normalizeLineItems([
          { id: 'nope', quantity: 1 },
          { id: 'copper-pen', quantity: 1 },
          { id: 'ceramic-mug', quantity: 1 },
        ]),
      /unknown item/
    );
    assert.throws(
      () =>
        normalizeLineItems([
          { id: 'aurora-notebook', quantity: 2 },
          { id: 'copper-pen', quantity: 1 },
          { id: 'ceramic-mug', quantity: 1 },
        ]),
      /quantity must be exactly 1/
    );
  });

  await test('calculateTotals applies tax and shipping', () => {
    const totals = calculateTotals(normalizeLineItems(threeItems()));
    assert.equal(totals.subtotalCents, 1200 + 700 + 900);
    assert.equal(totals.shippingCents, 499);
    assert.equal(totals.taxCents, Math.round((totals.subtotalCents * 825) / 10_000));
    assert.equal(totals.totalCents, totals.subtotalCents + totals.taxCents + totals.shippingCents);
  });

  await test('assertCardPresent enforces every card field', () => {
    assert.throws(() => assertCardPresent(null), /card is required/);
    assert.throws(
      () => assertCardPresent({ number: '123', expiry: '12/30', cvv: '123', name: 'A' }),
      /card number/
    );
    assert.throws(
      () => assertCardPresent({ number: '4242424242424242', expiry: 'bad', cvv: '123', name: 'A' }),
      /expiry/
    );
    assert.throws(
      () => assertCardPresent({ number: '4242424242424242', expiry: '12/30', cvv: '1', name: 'A' }),
      /cvv/
    );
    assert.throws(
      () =>
        assertCardPresent({ number: '4242424242424242', expiry: '12/30', cvv: '123', name: '  ' }),
      /name/
    );
    assertCardPresent({ number: '4242 4242 4242 4242', expiry: '12/30', cvv: '123', name: 'Rose' });
  });

  await test('normalizeExpiry handles 2- and 4-digit years and rejects bad input', () => {
    assert.deepEqual(normalizeExpiry('12/30'), { expMonth: 12, expYear: 2030 });
    assert.deepEqual(normalizeExpiry('01/2031'), { expMonth: 1, expYear: 2031 });
    assert.throws(() => normalizeExpiry('99/30'), /month is invalid/);
    assert.throws(() => normalizeExpiry('not-a-date'), /expiry is invalid/);
  });

  await test('AgentCard sandbox PAN detection + payment-method routing', () => {
    assert.equal(isAgentCardSandboxPan('4242 4242 4242 0640'), true);
    assert.equal(isAgentCardSandboxPan('4111111111111111'), false);
    assert.equal(paymentMethodIdForBenchmarkCard('4242424242420640'), 'pm_card_visa');
    assert.equal(paymentMethodIdForBenchmarkCard('4111111111111111'), null);
  });

  await test('getTestPaymentCatalog returns the five benchmark items', () => {
    const catalog = getTestPaymentCatalog();
    assert.equal(catalog.items.length, 5);
    assert.ok(catalog.items.every((item) => item.imageUrl.startsWith('https://')));
  });

  // ── service: confirm ──
  await test('confirmTestPayment settles an AgentCard sandbox PAN via injected settlement', async () => {
    const result = await confirmTestPayment(
      {
        items: threeItems(),
        card: { number: '4242424242420640', expiry: '12/30', cvv: '123', name: 'Rose' },
      },
      {
        settleAgentCardSandboxPayment: async (input) => {
          assert.equal(
            input.amountCents,
            calculateTotals(normalizeLineItems(threeItems())).totalCents
          );
          return {
            purchaseId: 'purchase-x',
            cardId: 'card-x',
            stripePaymentIntentId: 'pi_x',
          };
        },
      }
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.purchaseId, 'purchase-x');
    assert.equal(result.cardId, 'card-x');
    assert.equal(result.receipt.lineItems.length, 3);
  });

  await test('confirmTestPayment charges a non-sandbox card through Stripe', async () => {
    await withStubbedStripe(async () => {
      const result = await confirmTestPayment({
        items: threeItems(),
        card: {
          number: '4111111111111111',
          expiry: '12/30',
          cvv: '123',
          name: 'Rose',
          postalCode: '94107',
        },
      });
      assert.equal(result.status, 'succeeded');
      assert.ok(result.paymentIntentId?.startsWith('pi_'));
    });
  });

  await test('confirmTestPayment rejects a Stripe intent that did not succeed', async () => {
    const paymentMethods = stripe.paymentMethods as unknown as {
      create: (p: unknown) => Promise<{ id: string }>;
    };
    const paymentIntents = stripe.paymentIntents as unknown as {
      create: (p: unknown) => Promise<{ id: string; status: string }>;
    };
    const originalPm = paymentMethods.create;
    const originalPi = paymentIntents.create;
    paymentMethods.create = async () => ({ id: 'pm_x' });
    paymentIntents.create = async () => ({ id: 'pi_x', status: 'requires_action' });
    try {
      await assert.rejects(
        () =>
          confirmTestPayment({
            items: threeItems(),
            card: { number: '4111111111111111', expiry: '12/30', cvv: '123', name: 'Rose' },
          }),
        (error: unknown) => error instanceof TestPaymentError && error.statusCode === 402
      );
    } finally {
      paymentMethods.create = originalPm;
      paymentIntents.create = originalPi;
    }
  });

  // ── service: phone benchmark ──
  await test('confirmPhoneBenchmarkPayment uses the known Stripe test method for sandbox PANs', async () => {
    const paymentIntents = stripe.paymentIntents as unknown as {
      create: (p: unknown) => Promise<{ id: string; status: string }>;
    };
    const original = paymentIntents.create;
    paymentIntents.create = async (params: unknown) => {
      assert.equal((params as { payment_method: string }).payment_method, 'pm_card_visa');
      return { id: 'pi_phone', status: 'succeeded' };
    };
    try {
      const result = await confirmPhoneBenchmarkPayment({
        cardNumber: '4242424242420640',
        expiration: '12/30',
        cvc: '123',
        billingZip: '94107',
      });
      assert.equal(result.status, 'succeeded');
      assert.equal(result.total, '$34.20');
      assert.equal(result.cardLastFour, '0640');
      assert.equal(result.confirmationCode, 'ROSE-4471');
    } finally {
      paymentIntents.create = original;
    }
  });

  await test('confirmPhoneBenchmarkPayment validates its inputs', async () => {
    await assert.rejects(
      () =>
        confirmPhoneBenchmarkPayment({
          cardNumber: '123',
          expiration: '12/30',
          cvc: '123',
          billingZip: '94107',
        }),
      /cardNumber is required/
    );
    await assert.rejects(
      () =>
        confirmPhoneBenchmarkPayment({
          cardNumber: '4242424242420640',
          expiration: '12/30',
          cvc: '123',
          billingZip: '94107',
          amountCents: 999,
        }),
      /amountCents must be 3420/
    );
  });

  await test('recordPhoneBenchmarkPaymentAudit appends a JSONL entry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'phone-audit-'));
    const auditPath = path.join(dir, 'audit.jsonl');
    process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH = auditPath;
    try {
      const entry = await recordPhoneBenchmarkPaymentAudit({
        toolCallId: 'call-1',
        status: 'succeeded',
        paymentIntentId: 'pi_phone',
        amountCents: 3420,
        confirmationCode: 'ROSE-4471',
      });
      assert.ok(entry.createdAt.length > 0);
      const lines = (await readFile(auditPath, 'utf8')).trim().split('\n');
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]) as { toolCallId: string; paymentIntentId: string };
      assert.equal(parsed.toolCallId, 'call-1');
      assert.equal(parsed.paymentIntentId, 'pi_phone');
    } finally {
      delete process.env.PHONE_BENCHMARK_PAYMENT_AUDIT_PATH;
    }
  });

  // ── service: benchmark AgentCard setup + misc ──
  await test('configureBenchmarkAgentCardSetup toggles connect/reset state', async () => {
    const userId = await seedUser();
    await assert.rejects(
      () => configureBenchmarkAgentCardSetup({ action: 'complete' }),
      /userId is required/
    );
    await assert.rejects(
      () => configureBenchmarkAgentCardSetup({ userId, action: 'nonsense' }),
      /action must be reset or complete/
    );
    const connected = await configureBenchmarkAgentCardSetup({ userId, action: 'complete' });
    assert.equal(connected.status, 'connected');
    const row = await prisma.integration.findUnique({
      where: { userId_name: { userId, name: 'agentcard' } },
    });
    const config = row?.config as { orgManaged?: boolean; cardholderId?: string };
    assert.equal(config?.orgManaged, true);
    assert.ok((config?.cardholderId ?? '').length > 0);
    const reset = await configureBenchmarkAgentCardSetup({ userId, action: 'reset' });
    assert.equal(reset.status, 'connect_required');
    assert.equal(
      await prisma.integration.findUnique({
        where: { userId_name: { userId, name: 'agentcard' } },
      }),
      null
    );
  });

  await test('resolvePublicBaseUrl reflects the configured value', async () => {
    const url = await resolvePublicBaseUrl();
    assert.ok(url === null || typeof url === 'string');
  });

  await test('abandonTestPayment returns an empty lifecycle for an unknown agent', async () => {
    const lifecycle = await abandonTestPayment(`agent-${randomUUID()}`);
    assert.equal(lifecycle.purchase, null);
    assert.deepEqual(lifecycle.attention, { openKinds: [], resolvedKinds: [] });
    await assert.rejects(() => abandonTestPayment('   '), /agentId is required/);
  });

  // ── lifecycle ──
  await test('getTestPaymentLifecycle returns a null lifecycle when no purchase exists', async () => {
    const lifecycle = await getTestPaymentLifecycle('agent-none', {
      findPurchase: async () => null,
      findAttentionRequests: async () => [
        { id: 'a1', userResponse: null, metadata: { attentionKind: 'kyc' } },
        { id: 'a2', userResponse: 'ok', metadata: { attentionKind: 'card' } },
      ],
    });
    assert.equal(lifecycle.purchase, null);
    assert.deepEqual(lifecycle.attention.openKinds, ['kyc']);
    assert.deepEqual(lifecycle.attention.resolvedKinds, ['card']);
    await assert.rejects(() => getTestPaymentLifecycle('  '), /agentId is required/);
  });

  await test('getTestPaymentLifecycle cross-checks purchase, hold, refund, card, and transfer', async () => {
    const cardId = 'card-life-1';
    const lifecycle = await getTestPaymentLifecycle('agent-life', {
      findPurchase: async () => ({
        id: 'p1',
        userId: 'u1',
        status: PurchaseSpendStatus.CLEARED,
        merchant: 'Rose Labs Test Payment',
        totalCents: 4396,
        cardId,
        stripePaymentIntentId: 'pi_life',
        walletFunding: {
          status: 'CONSUMED',
          amountCents: 4396,
          providerTransferId: 'owt_life',
          reclaimProviderTransferId: null,
        },
      }),
      findAttentionRequests: async () => [],
      getCardSummary: async (_userId, id) => {
        assert.equal(id, cardId);
        return { status: 'CLOSED', balanceCents: 0 };
      },
      retrieveStripeHold: async () => ({
        id: 'pi_life',
        status: 'succeeded',
        amount: 4396,
        amount_capturable: 0,
        amount_received: 4396,
      }),
      listStripeRefunds: async () => ({
        data: [{ id: 're_1', status: 'succeeded', amount: 4396 }],
      }),
      listOrgTransfers: async () => ({
        structuredContent: {
          transfers: [
            {
              id: 'owt_life',
              status: 'consumed',
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: 0,
              card_id: cardId,
              livemode: false,
            },
          ],
        },
      }),
    });
    assert.equal(lifecycle.purchase?.id, 'p1');
    assert.equal(lifecycle.walletFunding?.status, 'CONSUMED');
    assert.equal(lifecycle.stripeHold?.amountReceivedCents, 4396);
    assert.equal(lifecycle.stripeRefund?.amountCents, 4396);
    assert.equal(lifecycle.agentCard?.status, 'CLOSED');
    assert.equal(lifecycle.orgTransfer?.id, 'owt_life');
    assert.equal(lifecycle.orgTransfer?.transferredCents, 4396);
    assert.equal(lifecycle.orgTransfer?.cardId, cardId);
  });

  process.stdout.write(
    `\nTest-payment service unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

async function cleanup(): Promise<void> {
  for (const userId of createdUserIds) {
    await prisma.integration.deleteMany({ where: { userId } });
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
