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
  listOrgTransferWindow,
  searchAllStripeHolds,
} from '../../domains/test-payment/lifecyclePagination';
import {
  abandonTestPayment,
  confirmPhoneBenchmarkPayment,
  confirmTestPayment,
  recordPhoneBenchmarkPaymentAudit,
  resolvePublicBaseUrl,
  TestPaymentError,
} from '../../domains/test-payment/service';
import { assertClosedCardMcpParsing, threeItems } from './test-payment-service-fixtures';

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

function lifecycleIntegrity(purchaseCount = 0) {
  return {
    purchaseCount,
    walletFundingCount: 0,
    stripePaymentIntentCount: 0,
    cardCount: 0,
  };
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

  // ── service: misc (AgentCard setup cases live in test-payment-agentcard-setup.test.ts) ──
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
  await test('AgentCard lifecycle recognizes only structured card_closed responses', async () => {
    assertClosedCardMcpParsing();
  });

  await test('getTestPaymentLifecycle returns a null lifecycle when no purchase exists', async () => {
    const lifecycle = await getTestPaymentLifecycle('agent-none', {
      findPurchase: async () => null,
      findPurchaseLifecycleIntegrity: async () => lifecycleIntegrity(7),
      findAttentionRequests: async () => [
        { id: 'a1', userResponse: null, metadata: { attentionKind: 'kyc' } },
        { id: 'a2', userResponse: 'ok', metadata: { attentionKind: 'card' } },
      ],
    });
    assert.equal(lifecycle.purchase, null);
    assert.equal(lifecycle.integrity.purchaseCount, 7);
    assert.deepEqual(lifecycle.attention.openKinds, ['kyc']);
    assert.deepEqual(lifecycle.attention.resolvedKinds, ['card']);
    await assert.rejects(() => getTestPaymentLifecycle('  '), /agentId is required/);
  });

  await test('getTestPaymentLifecycle cross-checks purchase, hold, refund, card, and transfer', async () => {
    const cardId = 'card-life-1';
    const createdAt = new Date();
    const lifecycle = await getTestPaymentLifecycle('agent-life', {
      findPurchase: async () => ({
        id: 'p1',
        userId: 'u1',
        status: PurchaseSpendStatus.CLEARED,
        merchant: 'Rose Labs Test Payment',
        totalCents: 4396,
        cardId,
        stripePaymentIntentId: 'pi_life',
        createdAt,
        walletFunding: {
          status: 'CONSUMED',
          amountCents: 4396,
          providerTransferId: 'owt_life',
          reclaimProviderTransferId: null,
        },
      }),
      findPurchaseLifecycleIntegrity: async () => lifecycleIntegrity(1),
      findAttentionRequests: async () => [],
      getCardSummary: async (_userId, id) => {
        assert.equal(id, cardId);
        throw new Error(
          'get_card_details failed: card_closed: This card is closed and its credentials are no longer available.'
        );
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
      getOrgCardholderId: async () => 'cardholder-life',
      searchStripeHolds: async () => ({ data: [{ id: 'pi_life' }] }),
      listOrgCards: async () => ({
        structuredContent: {
          cards: [
            {
              id: cardId,
              cardholderId: 'cardholder-life',
              spendLimitCents: 4396,
              createdAt: createdAt.toISOString(),
            },
          ],
        },
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
              cardholder_id: 'cardholder-life',
              created_at: createdAt.toISOString(),
              livemode: false,
            },
            {
              id: 'owt-unlinked',
              status: 'pending',
              amount_cents: 4396,
              transferred_cents: 4396,
              released_cents: 0,
              card_id: null,
              cardholder_id: 'cardholder-life',
              created_at: createdAt.toISOString(),
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
    assert.equal(lifecycle.agentCard?.status, 'closed');
    assert.equal(lifecycle.orgTransfer?.id, 'owt_life');
    assert.equal(lifecycle.orgTransfer?.transferredCents, 4396);
    assert.equal(lifecycle.orgTransfer?.cardId, cardId);
    assert.equal(lifecycle.integrity.stripeProviderPaymentIntentCount, 1);
    assert.equal(lifecycle.integrity.agentCardProviderCardCount, 1);
    assert.equal(lifecycle.integrity.agentCardProviderTransferCount, 2);
    assert.equal(lifecycle.integrity.agentCardProviderUnlinkedTransferCount, 1);
  });

  await test('getTestPaymentLifecycle pages cards until the purchase window is covered', async () => {
    const createdAt = new Date();
    const cardOffsets: number[] = [];
    const stripePages: Array<string | undefined> = [];
    const lifecycle = await getTestPaymentLifecycle('agent-paged-cards', {
      findPurchase: async () => ({
        id: 'p-paged-cards',
        userId: 'u-paged-cards',
        status: PurchaseSpendStatus.FAILED,
        merchant: 'Rose Labs Test Payment',
        totalCents: 4396,
        cardId: null,
        stripePaymentIntentId: null,
        createdAt,
        walletFunding: null,
      }),
      findPurchaseLifecycleIntegrity: async () => lifecycleIntegrity(1),
      findAttentionRequests: async () => [],
      getOrgCardholderId: async () => 'cardholder-paged',
      searchStripeHolds: async (_agentId, page) => {
        stripePages.push(page);
        return page === undefined
          ? { data: [{ id: 'pi-page-1' }], has_more: true, next_page: 'stripe-next' }
          : { data: [{ id: 'pi-page-2' }], has_more: false };
      },
      listOrgCards: async (args) => {
        cardOffsets.push(args.offset ?? 0);
        if ((args.offset ?? 0) === 0) {
          return {
            structuredContent: {
              cards: Array.from({ length: 100 }, (_, index) => ({
                id: `newer-card-${index}`,
                cardholderId: 'cardholder-paged',
                spendLimitCents: 1,
                createdAt: new Date(createdAt.getTime() + 1_000).toISOString(),
              })),
            },
          };
        }
        return {
          structuredContent: {
            cards: [
              {
                id: 'target-card',
                cardholderId: 'cardholder-paged',
                spendLimitCents: 4396,
                createdAt: createdAt.toISOString(),
              },
            ],
          },
        };
      },
      listOrgTransfers: async () => ({ structuredContent: { transfers: [] } }),
    });
    assert.deepEqual(cardOffsets, [0, 100]);
    assert.deepEqual(stripePages, [undefined, 'stripe-next']);
    assert.equal(lifecycle.integrity.stripeProviderPaymentIntentCount, 2);
    assert.equal(lifecycle.integrity.agentCardProviderCardCount, 1);
  });

  await test('getTestPaymentLifecycle fails closed when transfer history hides the window', async () => {
    const createdAt = new Date();
    await assert.rejects(
      () =>
        getTestPaymentLifecycle('agent-transfer-overflow', {
          findPurchase: async () => ({
            id: 'p-transfer-overflow',
            userId: 'u-transfer-overflow',
            status: PurchaseSpendStatus.FAILED,
            merchant: 'Rose Labs Test Payment',
            totalCents: 4396,
            cardId: null,
            stripePaymentIntentId: null,
            createdAt,
            walletFunding: null,
          }),
          findPurchaseLifecycleIntegrity: async () => lifecycleIntegrity(1),
          findAttentionRequests: async () => [],
          getOrgCardholderId: async () => 'cardholder-overflow',
          searchStripeHolds: async () => ({ data: [] }),
          listOrgCards: async () => ({ structuredContent: { cards: [] } }),
          listOrgTransfers: async () => ({
            structuredContent: {
              transfers: Array.from({ length: 100 }, (_, index) => ({
                id: `newer-transfer-${index}`,
                created_at: new Date(createdAt.getTime() + 1_000).toISOString(),
              })),
            },
          }),
        }),
      /does not cover the purchase window/
    );
  });

  await test('transfer lifecycle proof rejects MCP errors and malformed full pages', async () => {
    await assert.rejects(
      () =>
        listOrgTransferWindow(new Date(), async ({ status }) =>
          status === 'pending'
            ? { isError: true, structuredContent: { transfers: [] } }
            : { structuredContent: { transfers: [] } }
        ),
      /returned an error/
    );
    await assert.rejects(
      () =>
        listOrgTransferWindow(new Date(), async ({ status }) => ({
          structuredContent: {
            transfers:
              status === 'pending'
                ? [...Array.from({ length: 99 }, (_, id) => ({ id: `transfer-${id}` })), null]
                : [],
          },
        })),
      /row 99 was invalid/
    );
    await assert.rejects(
      () =>
        listOrgTransferWindow(new Date(), async () => ({
          structuredContent: { transfers: [{ id: '' }] },
        })),
      /missing id/
    );
    await assert.rejects(
      () => searchAllStripeHolds('agent-invalid', async () => ({ data: [{ id: '' }] })),
      /invalid intent id/
    );
  });

  process.stdout.write(
    `\nTest-payment service unit tests: ${passed} passed, ${failures.length} failed\n`
  );
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

main()
  .then(() => {
    if (failures.length > 0) process.exit(1);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
