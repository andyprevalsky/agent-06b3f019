/**
 * Live Rose Labs Pro checkouts must persist stripeLivemode=true so the billing
 * portal opens on the live account. Legacy sandbox rows default to false.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import * as webhooksRepo from '../../domains/webhooks/repo';

async function main(): Promise<void> {
  const userId = `livemode-${randomUUID()}`;
  await prisma.user.create({ data: { userId } });

  try {
    await webhooksRepo.upsertSubscription({
      userId,
      subscriptionTier: 30,
      stripeSubscriptionId: `sub_live_${randomUUID()}`,
      stripeCustomerId: `cus_live_${randomUUID()}`,
      stripeLivemode: true,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const live = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
    assert.equal(live.stripeLivemode, true, 'live checkout must persist stripeLivemode=true');

    await webhooksRepo.upsertSubscription({
      userId,
      subscriptionTier: 30,
      stripeSubscriptionId: live.stripeSubscriptionId,
      stripeCustomerId: live.stripeCustomerId,
      stripeLivemode: false,
      currentPeriodEnd: live.currentPeriodEnd,
    });

    const sandbox = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
    assert.equal(sandbox.stripeLivemode, false, 'upsert must be able to flip livemode');

    const defaultUserId = `livemode-default-${randomUUID()}`;
    await prisma.user.create({ data: { userId: defaultUserId } });
    await prisma.subscription.create({
      data: {
        userId: defaultUserId,
        subscriptionTier: 30,
        stripeSubscriptionId: `sub_default_${randomUUID()}`,
        stripeCustomerId: `cus_default_${randomUUID()}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    const legacy = await prisma.subscription.findUniqueOrThrow({
      where: { userId: defaultUserId },
    });
    assert.equal(legacy.stripeLivemode, false, 'schema default backfills legacy rows as test-mode');
    await prisma.subscription.delete({ where: { userId: defaultUserId } });
    await prisma.user.delete({ where: { userId: defaultUserId } });

    process.stdout.write('subscription-stripe-livemode tests passed\n');
  } finally {
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
