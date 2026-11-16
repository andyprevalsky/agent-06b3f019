/**
 * The owner admin runs the live production lifecycle probe (providers/ownerLifecycleBilling.ts).
 * Only its benchmark agents take the charged path against the dedicated live customer; its other
 * agents keep the admin company card, and the owner's own Subscription is never read or written.
 */
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { BENCHMARK_PAYMENT_LIFECYCLE_OWNER_USER_ID as owner } from '../../providers/benchmarkPaymentIdentity';
import type { createPendingPurchaseWithLock as CreatePending } from '../../domains/purchases/repoOpen';
import type { resolveAndIssuePurchaseCard as ResolveAndIssue } from '../../domains/purchases/issueCard';
import type {
  FakeCardProvider as FakeCard,
  FakeWalletFundingProvider as FakeWallet,
} from './purchases.testkit';

export interface OwnerLifecycleDeps {
  prisma: PrismaClient;
  calls: Array<{ path: string; mode: boolean; customer: string | null }>;
  users: string[];
  check: (label: string, run: () => Promise<void>) => Promise<void>;
  createPendingPurchaseWithLock: typeof CreatePending;
  resolveAndIssuePurchaseCard: typeof ResolveAndIssue;
  FakeCardProvider: typeof FakeCard;
  FakeWalletFundingProvider: typeof FakeWallet;
}

export async function assertOwnerLifecycleBilling(deps: OwnerLifecycleDeps): Promise<void> {
  const {
    prisma,
    calls,
    users,
    check,
    createPendingPurchaseWithLock,
    resolveAndIssuePurchaseCard,
    FakeCardProvider,
    FakeWalletFundingProvider,
  } = deps;
  // The owner admin runs the live production lifecycle probe. Only its benchmark agents take the
  // charged path against the dedicated live customer; its other agents keep the admin company
  // card, and the owner's own Subscription is never read or written.
  const ownerExisted = (await prisma.user.findUnique({ where: { userId: owner } })) !== null;
  if (!ownerExisted) {
    await prisma.user.create({ data: { userId: owner } });
    users.push(owner);
  }
  const ownerSubscriptionBefore = await prisma.subscription.findUnique({
    where: { userId: owner },
  });
  const ownerAgents: string[] = [];
  process.env.BENCHMARK_PAYMENT_LIFECYCLE_STRIPE_CUSTOMER_ID = 'cus_live_owner_probe';
  try {
    for (const isBenchmark of [true, false]) {
      const agent = await prisma.agent.create({
        data: { userId: owner, goal: 'owner lifecycle probe fixture', isBenchmark },
      });
      ownerAgents.push(agent.id);
      const input = {
        userId: owner,
        agentId: agent.id,
        merchant: 'Local Owner Lifecycle Fixture',
        totalCents: 100,
        subtotalCents: 100,
        fingerprint: `owner-lifecycle-${agent.id}`,
        currency: 'usd',
        lineItems: [],
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
      await check(`owner lifecycle billing benchmark=${isBenchmark}`, async () => {
        const issued = await resolveAndIssuePurchaseCard(purchase, input, null, card, wallet);
        assert.equal(issued.cardId, card.cardId);
        const stored = await prisma.purchaseSpend.findUniqueOrThrow({
          where: { id: purchase.id },
        });
        if (isBenchmark) {
          assert.equal(stored.stripeLivemode, true);
          assert.equal(stored.stripeCustomerId, 'cus_live_owner_probe');
          assert.equal(stored.stripeSubscriptionId, null);
          const charged = calls.slice(cursor).filter((call) => call.customer);
          assert.ok(charged.length > 0, 'owner benchmark probe must place a Stripe hold');
          assert.ok(charged.every((call) => call.customer === 'cus_live_owner_probe'));
        } else {
          assert.equal(calls.length, cursor, 'ordinary owner agent must keep the admin card path');
        }
      });
    }
    await check('owner lifecycle purge removes only settled benchmark probe records', async () => {
      const { purgeOwnerLifecycleProbeRecords } =
        await import('../../domains/test-payment/purgeLifecycleRecords');
      const [benchmarkAgent, ordinaryAgent] = ownerAgents;
      const ordinaryBefore = await prisma.purchaseSpend.count({
        where: { agentId: ordinaryAgent },
      });
      await assert.rejects(
        purgeOwnerLifecycleProbeRecords(ordinaryAgent),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 403
      );
      const probe = await prisma.purchaseSpend.findFirstOrThrow({
        where: { agentId: benchmarkAgent },
      });
      await prisma.purchaseSpend.update({ where: { id: probe.id }, data: { status: 'HELD' } });
      await assert.rejects(
        purgeOwnerLifecycleProbeRecords(benchmarkAgent),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 409
      );
      assert.equal(await prisma.purchaseSpend.count({ where: { id: probe.id } }), 1);
      await prisma.purchaseSpend.update({ where: { id: probe.id }, data: { status: 'REFUNDED' } });
      await prisma.purchaseWalletFunding.updateMany({
        where: { purchaseId: probe.id },
        data: { status: 'RECLAIMED' },
      });
      const purged = await purgeOwnerLifecycleProbeRecords(benchmarkAgent);
      assert.ok(purged.purged >= 1);
      assert.equal(await prisma.purchaseSpend.count({ where: { agentId: benchmarkAgent } }), 0);
      assert.equal(
        await prisma.purchaseSpend.count({ where: { agentId: ordinaryAgent } }),
        ordinaryBefore,
        "purge must never touch the owner's ordinary purchases"
      );
    });
    await check('owner subscription untouched by lifecycle probe', async () => {
      assert.deepEqual(
        await prisma.subscription.findUnique({ where: { userId: owner } }),
        ownerSubscriptionBefore
      );
    });
  } finally {
    delete process.env.BENCHMARK_PAYMENT_LIFECYCLE_STRIPE_CUSTOMER_ID;
    await prisma.purchaseSpend.deleteMany({ where: { agentId: { in: ownerAgents } } });
    await prisma.agent.deleteMany({ where: { id: { in: ownerAgents } } });
  }
}
