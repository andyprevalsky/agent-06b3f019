/** Actual purchase repository + Stripe SDK over loopback; isolated DB only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? '');
  const direct = new URL(process.env.DIRECT_URL ?? '');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol));
  assert.notEqual(database.pathname, '/');
  assert.equal(direct.hostname, database.hostname);
  assert.equal(direct.port, database.port);
  assert.equal(direct.pathname, database.pathname);
  globalThis.fetch = async () => {
    throw new Error('External fetch forbidden in local Stripe proof');
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_mode_fixture';
  process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_local_mode_fixture';
  let refundLink: 'string' | 'expanded' | 'missing' | 'mismatch' = 'string';
  let lifecycleIntent = '';
  let nativeModeOverride: boolean | undefined;
  const calls: Array<{ path: string; mode: boolean; customer: string | null }> = [];
  const intents = new Map<
    string,
    {
      id: string;
      object: string;
      livemode: boolean;
      status: string;
      amount: number;
      amount_received: number;
      amount_capturable: number;
    }
  >();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    const path = request.url ?? '';
    const mode = request.headers.authorization?.startsWith('Bearer sk_live_') === true;
    const customer = body.get('customer');
    calls.push({ path, mode, customer });
    response.setHeader('content-type', 'application/json');
    const id = path.match(/pi_(?:live|test)_[\w-]+/)?.[0] ?? body.get('payment_intent');
    const nativeMode = path.includes('/payment_intents/search')
      ? lifecycleIntent.includes('_live_')
      : customer
        ? customer.includes('_live')
        : id
          ? id.includes('_live_')
          : path.includes('cus_live');
    if (mode !== nativeMode) {
      response.writeHead(404);
      response.end(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'resource_missing',
            message: 'Wrong local fixture account',
          },
        })
      );
      return;
    }
    if (path.includes('/payment_intents/search')) {
      response.end(
        JSON.stringify({
          object: 'search_result',
          data: [{ id: lifecycleIntent }],
          has_more: false,
        })
      );
      return;
    }
    if (path.startsWith('/v1/refunds?')) {
      const payment_intent =
        refundLink === 'missing'
          ? undefined
          : refundLink === 'mismatch'
            ? 'pi_other'
            : refundLink === 'expanded'
              ? { id: lifecycleIntent }
              : lifecycleIntent;
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 're_local', object: 'refund', status: 'succeeded', amount: 100, payment_intent },
          ],
          has_more: false,
        })
      );
      return;
    }
    if (path.includes('/customers/')) {
      response.end(
        JSON.stringify({
          id: mode ? 'cus_live' : 'cus_test',
          object: 'customer',
          livemode: mode,
          invoice_settings: { default_payment_method: mode ? 'pm_live' : 'pm_test' },
        })
      );
      return;
    }
    if (path === '/v1/payment_intents' && request.method === 'POST') {
      const pi = `pi_${mode ? 'live' : 'test'}_${body.get('metadata[purchaseSpendId]')}`;
      const value = intents.get(pi) ?? {
        id: pi,
        object: 'payment_intent',
        livemode: mode,
        status: 'requires_capture',
        amount: 100,
        amount_received: 0,
        amount_capturable: 100,
      };
      intents.set(pi, value);
      response.end(JSON.stringify(value));
      return;
    }
    if (path.startsWith('/v1/refunds')) {
      response.end(
        JSON.stringify({
          id: `re_${mode ? 'live' : 'test'}`,
          object: 'refund',
          livemode: mode,
          status: 'succeeded',
          amount: 100,
        })
      );
      return;
    }
    if (id) {
      const value = intents.get(id) ?? {
        id,
        object: 'payment_intent',
        livemode: mode,
        status: 'succeeded',
        amount: 100,
        amount_received: 100,
        amount_capturable: 0,
      };
      if (path.endsWith('/capture')) {
        value.status = 'succeeded';
        value.amount_received = 100;
        value.amount_capturable = 0;
      }
      if (path.endsWith('/cancel')) {
        value.status = 'canceled';
        value.amount_received = 0;
        value.amount_capturable = 0;
      }
      intents.set(id, value);
      response.end(JSON.stringify({ ...value, livemode: nativeModeOverride ?? value.livemode }));
      return;
    }
    response.writeHead(500);
    response.end(JSON.stringify({ error: { message: 'Unexpected local fixture route' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { prisma } = await import('../../providers/database');
  const stripeModule = await import('../../providers/stripe');
  for (const mode of [false, true]) {
    const client = stripeModule.getStripeClientForLivemode(mode) as unknown as {
      _setApiField: (key: string, value: unknown) => void;
    };
    client._setApiField('host', '127.0.0.1');
    client._setApiField('port', address.port);
    client._setApiField('protocol', 'http');
  }
  const { createPendingPurchaseWithLock } = await import('../../domains/purchases/repoOpen');
  const { authorizeStripeHold } = await import('../../domains/purchases/chargeAuthorize');
  const { getTestPaymentLifecycle } = await import('../../domains/test-payment/lifecycle');
  const { resolveAndIssuePurchaseCard } = await import('../../domains/purchases/issueCard');
  const { mintPurchaseCard } = await import('../../domains/purchases/service');
  const { reverseStalePurchasePayment } = await import('../../providers/purchaseStaleReversal');
  const { reconcileAbandonedPurchaseFunding } =
    await import('../../providers/purchaseFundingCompensation');
  const { AgentCardProviderError } = await import('../../providers/card-provider/errors');
  const { BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID } =
    await import('../../providers/benchmarkPaymentIdentity');
  const { FakeCardProvider, FakeWalletFundingProvider } = await import('./purchases.testkit');
  const users: string[] = [];
  const failures: string[] = [];
  const check = async (label: string, run: () => Promise<void>) => {
    try {
      await run();
      console.log(`PASS ${label}`);
    } catch (error) {
      failures.push(`${label}: ${String(error)}`);
    }
  };
  try {
    for (const mode of [false, true]) {
      const userId = randomUUID();
      users.push(userId);
      await prisma.user.create({ data: { userId } });
      const customer = mode ? 'cus_live' : 'cus_test';
      await prisma.subscription.create({
        data: {
          userId,
          subscriptionTier: 1,
          stripeCustomerId: customer,
          stripeSubscriptionId: `sub_${userId}`,
          stripeLivemode: mode,
          currentPeriodEnd: new Date('2099-01-01'),
        },
      });
      const input = {
        userId,
        merchant: 'Local Mode Fixture',
        totalCents: 100,
        fingerprint: `mode-${userId}`,
        canonicalFingerprint: `canonical-${userId}`,
        lineItemsJson: [],
      };
      const opened = await createPendingPurchaseWithLock(input);
      const purchase = opened.purchase;
      await check(`new purchase snapshots ${mode}`, async () => {
        assert.equal(purchase.stripeLivemode, mode);
        assert.equal(purchase.stripeCustomerId, customer);
        assert.equal(purchase.stripeSubscriptionId, `sub_${userId}`);
      });
      await prisma.subscription.update({
        where: { userId },
        data: {
          stripeLivemode: !mode,
          stripeCustomerId: mode ? 'cus_test' : 'cus_live',
          stripeSubscriptionId: `changed_${userId}`,
        },
      });
      await check(`reuse preserves ${mode}`, async () => {
        const reused = await createPendingPurchaseWithLock(input);
        assert.equal(reused.created, false);
        assert.equal(reused.purchase.stripeLivemode, mode);
        assert.equal(reused.purchase.stripeCustomerId, customer);
      });
      await check(`authorize after subscription switch ${mode}`, async () => {
        const state = {
          paymentIntentCaptured: false,
          paymentReversalFailed: false,
          walletWasFunded: false,
          walletReclaimFailed: false,
          walletFundingPrepared: false,
          fundingResumeRequired: false,
          fundingRetryClaimed: false,
          providerCallStarted: false,
          stripeAuthorizationStarted: false,
          issuedStaticCard: false,
        };
        const pi = await authorizeStripeHold(
          state,
          purchase,
          {
            userId,
            merchant: input.merchant,
            totalCents: 100,
            fingerprint: input.fingerprint,
            lineItems: [],
            fees: [],
            currency: 'usd',
            subtotalCents: 100,
          },
          mode ? 'cus_test' : 'cus_live',
          `changed_${userId}`
        );
        assert.equal(pi.livemode, mode);
        assert.equal(calls.at(-1)?.customer, customer);
      });
      await check(`capture + refund after subscription switch ${mode}`, async () => {
        const pi = `pi_${mode ? 'live' : 'test'}_${purchase.id}`;
        await stripeModule.captureAuthorizedHold(pi, mode);
        assert.equal(
          await stripeModule.reversePurchasePaymentIntent(pi, purchase.id, mode),
          'refunded'
        );
      });
      lifecycleIntent = `pi_${mode ? 'live' : 'test'}_${purchase.id}`;
      const lifecycle = (
        overrides: import('../../domains/test-payment/lifecycle').TestPaymentLifecycleDependencies = {}
      ) =>
        getTestPaymentLifecycle('local-mode-agent', {
          findPurchase: () =>
            prisma.purchaseSpend.findUnique({
              where: { id: purchase.id },
              include: { walletFunding: true },
            }),
          findAttentionRequests: async () => [],
          findPurchaseLifecycleIntegrity: async () => ({
            purchaseCount: 1,
            walletFundingCount: 0,
            stripePaymentIntentCount: 1,
            cardCount: 0,
          }),
          getOrgCardholderId: async () => undefined,
          ...overrides,
        });
      if (mode) {
        const savedLiveKey = process.env.STRIPE_SECRET_KEY_LIVE;
        const savedAdminKey = process.env.ADMIN_HEALTH_STRIPE_SECRET_KEY;
        delete process.env.STRIPE_SECRET_KEY_LIVE;
        delete process.env.ADMIN_HEALTH_STRIPE_SECRET_KEY;
        try {
          await check('fully injected live lifecycle needs no Stripe credentials', async () => {
            await lifecycle({
              retrieveStripeHold: async () => ({
                ...intents.get(lifecycleIntent)!,
                livemode: true,
              }),
              listStripeRefunds: async () => ({ data: [] }),
              searchStripeHolds: async () => ({ data: [], has_more: false }),
              getCardSummary: async () => ({ status: 'closed', balanceCents: 0 }),
              listOrgTransfers: async () => ({}),
              listOrgCards: async () => ({}),
            });
          });
          await check('default live lifecycle still requires live credentials', async () => {
            await assert.rejects(lifecycle, /Live-mode Stripe event requires/);
          });
        } finally {
          process.env.STRIPE_SECRET_KEY_LIVE = savedLiveKey;
          if (savedAdminKey !== undefined)
            process.env.ADMIN_HEALTH_STRIPE_SECRET_KEY = savedAdminKey;
        }
      }
      for (refundLink of ['string', 'expanded'] as const) {
        await check(`verified lifecycle ${mode}/${refundLink}`, async () => {
          const result = await lifecycle();
          assert.equal(result.stripeHold?.livemode, mode);
          assert.equal(result.stripeRefund?.paymentIntentLivemode, mode);
          assert.equal(result.stripeRefund?.paymentIntentId, lifecycleIntent);
          assert.equal('livemode' in (result.stripeRefund ?? {}), false);
        });
      }
      for (refundLink of ['missing', 'mismatch'] as const) {
        await check(`reject refund link ${mode}/${refundLink}`, async () => {
          await assert.rejects(lifecycle, /refund does not match/);
        });
      }
      refundLink = 'string';
      await check(`native mode evidence not overwritten ${mode}`, async () => {
        nativeModeOverride = !mode;
        try {
          assert.equal((await lifecycle()).stripeRefund?.paymentIntentLivemode, !mode);
        } finally {
          nativeModeOverride = undefined;
        }
      });
      await check(`cancel after subscription switch ${mode}`, async () => {
        const pi = `pi_${mode ? 'live' : 'test'}_uncaptured`;
        intents.set(pi, {
          id: pi,
          object: 'payment_intent',
          livemode: mode,
          status: 'requires_capture',
          amount: 100,
          amount_received: 0,
          amount_capturable: 100,
        });
        assert.equal(
          await stripeModule.reversePurchasePaymentIntent(pi, purchase.id, mode),
          'canceled'
        );
      });
      if (!mode)
        await check('legacy no-PI billing switch fails closed', async () => {
          const legacy = await prisma.purchaseSpend.create({
            data: {
              userId,
              merchant: 'Legacy fixture',
              fingerprint: `legacy-${userId}`,
              totalCents: 100,
              lineItemsJson: [],
            },
          });
          await assert.rejects(
            () =>
              resolveAndIssuePurchaseCard(
                legacy,
                {
                  userId,
                  merchant: legacy.merchant,
                  totalCents: 100,
                  fingerprint: legacy.fingerprint,
                  lineItems: [],
                  fees: [],
                  currency: 'usd',
                  subtotalCents: 100,
                },
                null
              ),
            /Billing account changed/
          );
        });
      await check(`stale reversal owns account ${mode}`, async () => {
        assert.equal(
          await reverseStalePurchasePayment({
            id: purchase.id,
            stripePaymentIntentId: lifecycleIntent,
            stripeLivemode: mode,
          }),
          'REFUNDED'
        );
      });
      await check(`unpersisted intent recovery owns account ${mode}`, async () => {
        await prisma.purchaseSpend.update({
          where: { id: purchase.id },
          data: { status: 'FUNDING_ABANDONED', stripePaymentIntentId: null },
        });
        await reconcileAbandonedPurchaseFunding(
          {
            mintCard: async () => {
              throw new AgentCardProviderError(
                'Owned terminal local mint failure',
                502,
                undefined,
                'agentcard_card_creation_failed'
              );
            },
            getDetails: async () => {
              throw new Error('No card was issued');
            },
            closeCard: async () => {
              throw new Error('No card was issued');
            },
          },
          undefined,
          { userId }
        );
        const recovered = await prisma.purchaseSpend.findUniqueOrThrow({
          where: { id: purchase.id },
        });
        assert.equal(recovered.status, 'FAILED');
        assert.equal(recovered.stripePaymentIntentId, lifecycleIntent);
      });
    }
    await check('legacy false cleanup never follows live subscription', async () => {
      await stripeModule.reversePurchasePaymentIntent('pi_test_legacy', 'legacy');
      assert.equal(calls.at(-1)?.mode, false);
    });
    await check('wrong-account resource_missing never retries another account', async () => {
      const cursor = calls.length;
      await assert.rejects(() =>
        stripeModule.captureAuthorizedHold('pi_live_wrong_account', false)
      );
      assert.ok(calls.length > cursor);
      assert.equal(
        calls.slice(cursor).every((call) => call.mode === false),
        true
      );
    });
    // The production identity may change after runner preflight. Exercise the actual
    // persisted purchase/issuance boundary with no external rails or known allocation.
    const productionUser = BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID;
    assert.equal(await prisma.user.findUnique({ where: { userId: productionUser } }), null);
    await prisma.user.create({ data: { userId: productionUser } });
    users.push(productionUser);
    for (const mode of [false, true]) {
      await prisma.subscription.upsert({
        where: { userId: productionUser },
        create: {
          userId: productionUser,
          subscriptionTier: 30,
          stripeCustomerId: mode ? 'cus_live' : 'cus_test',
          stripeSubscriptionId: 'sub_production_local_fixture',
          stripeLivemode: mode,
          currentPeriodEnd: new Date('2099-01-01'),
        },
        update: { stripeLivemode: mode, stripeCustomerId: mode ? 'cus_live' : 'cus_test' },
      });
      const input = {
        userId: productionUser,
        merchant: 'Local Production Admission Fixture',
        totalCents: 100,
        subtotalCents: 100,
        fingerprint: `production-mode-${mode}`,
        currency: 'usd',
        lineItems: [
          {
            name: 'Local fixture',
            productUrl: 'https://fixture.invalid/item',
            rating: '',
            reviewCount: '',
            unitPriceCents: 100,
            quantity: 1,
            lineTotalCents: 100,
          },
        ],
        fees: [],
      };
      const { purchase } = await createPendingPurchaseWithLock({
        ...input,
        canonicalFingerprint: input.fingerprint,
        lineItemsJson: [],
      });
      const card = new FakeCardProvider();
      const wallet = new FakeWalletFundingProvider();
      const cursor = calls.length;
      await check(`production purchase mode admission ${mode}`, async () => {
        if (!mode) {
          await assert.rejects(
            resolveAndIssuePurchaseCard(purchase, input, null, card, wallet),
            (error: unknown) =>
              error instanceof Error &&
              'code' in error &&
              error.code === 'production_payment_billing_mode'
          );
          assert.equal(calls.length, cursor, 'test-mode purchase reached Stripe');
          assert.equal(card.mintCalls, 0, 'test-mode purchase reached live AgentCard');
          assert.equal(
            (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } })).status,
            'FAILED',
            'fresh admission rejection must not strand a pending purchase'
          );
          await prisma.subscription.update({
            where: { userId: productionUser },
            data: { stripeLivemode: true, stripeCustomerId: 'cus_live' },
          });
          const retried = await mintPurchaseCard(input, card, wallet);
          assert.equal(retried.cardId, card.cardId);
          assert.equal(card.mintCalls, 1, 'valid retry must be admissible');
        } else {
          // A later subscription switch cannot change the immutable live snapshot.
          await prisma.subscription.update({
            where: { userId: productionUser },
            data: { stripeLivemode: false },
          });
          const issued = await resolveAndIssuePurchaseCard(purchase, input, null, card, wallet);
          assert.equal(issued.cardId, card.cardId);
          assert.equal(card.mintCalls, 1);
          assert.ok(calls.length > cursor);
          assert.ok(calls.slice(cursor).every((call) => call.mode === true));
        }
      });
    }
    assert.deepEqual(failures, []);
  } finally {
    await prisma.user.deleteMany({ where: { userId: { in: users } } });
    await prisma.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
