#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import { prisma } from '../../providers/database';
import { resolvePendingGateByKey } from '../../providers/gateResolution';
import { handleCheckoutSessionCompleted } from '../../domains/webhooks/service';

async function testCheckoutSessionCompletedResolvesSubscriptionGate(): Promise<void> {
  const userId = `wh-sub-gate-${Date.now()}`;
  const gateKey = 'subscription';

  await prisma.user.upsert({ where: { userId }, create: { userId }, update: {} });
  const request = await prisma.agentAttentionRequest.create({
    data: {
      userId,
      agentId: 'agent-test',
      workflowId: `wf-${userId}`,
      question: 'Subscribe to continue',
      gateKey,
      metadata: {
        gate: {
          gateKey,
          type: 'subscription',
          status: 'PENDING',
        },
      },
    },
  });

  try {
    await handleCheckoutSessionCompleted({
      id: `cs_test_${userId}`,
      object: 'checkout.session',
      mode: 'subscription',
      livemode: false,
      client_reference_id: userId,
      subscription: `sub_test_${userId}`,
      customer: `cus_test_${userId}`,
    } as never);

    const resolved = await resolvePendingGateByKey(userId, gateKey);
    assert.equal(resolved.resolved, false, 'gate should already be resolved');

    const row = await prisma.agentAttentionRequest.findUnique({ where: { id: request.id } });
    assert.equal(row?.userResponse, 'SUBSCRIPTION_ACTIVE');

    const subscription = await prisma.subscription.findUnique({ where: { userId } });
    assert.ok(subscription, 'subscription row should exist');
    assert.equal(subscription.subscriptionTier, 30);
  } finally {
    await prisma.credit.deleteMany({ where: { userId } });
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function main(): Promise<void> {
  await testCheckoutSessionCompletedResolvesSubscriptionGate();
}

main()
  .then(() => {
    process.stdout.write('subscription-webhook-checkout tests passed\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  });
