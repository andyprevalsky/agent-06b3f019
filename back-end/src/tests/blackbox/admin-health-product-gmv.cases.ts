import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { findProductGmvBetween } from '../../domains/admin-health/repoProductGmv';
import { prisma } from '../../providers/database';

/**
 * Platform GMV counts only real purchases agents made (prod 2026-10-28: the card
 * read ~$2.3k from an order-history lookup plus test-mode AgentCard fixtures).
 * Exercised against real PostgreSQL in the admin-health gate.
 */
export async function testProductGmvCohort(): Promise<void> {
  const customerId = randomUUID();
  const coreId = randomUUID();
  const fixtureId = randomUUID();
  const agents = Array.from({ length: 7 }, () => randomUUID());
  const [completedRoot, runningRoot, benchmarkRoot, coreRoot, fixtureRoot, archivedRoot, child] =
    agents;
  const start = new Date('2001-01-01T00:00:00.000Z');
  const end = new Date('2001-01-02T00:00:00.000Z');
  const at = new Date('2001-01-01T12:00:00.000Z');
  const purchaseIds: string[] = [];
  try {
    await prisma.user.createMany({
      data: [
        { userId: customerId, name: 'Real Customer', email: `${customerId}@customer.dev` },
        { userId: coreId, name: 'Core Teammate', phone: '+1 (713) 471-2306' },
        { userId: fixtureId, name: 'Fixture Person', email: `${fixtureId}@blackbox-test.dev` },
      ],
    });
    await prisma.agent.createMany({
      data: [
        { id: completedRoot, userId: customerId, status: 'COMPLETED' as const },
        { id: runningRoot, userId: customerId, status: 'ACTIVE' as const },
        { id: benchmarkRoot, userId: customerId, status: 'COMPLETED' as const, isBenchmark: true },
        { id: coreRoot, userId: coreId, status: 'COMPLETED' as const },
        { id: fixtureRoot, userId: fixtureId, status: 'COMPLETED' as const },
        // Archived after checkout: FAILED, but the order it placed is still real.
        { id: archivedRoot, userId: customerId, status: 'FAILED' as const },
      ].map((row) => ({ ...row, goal: 'buy floss', busId: row.id, createdAt: at })),
    });
    await prisma.agent.create({
      data: {
        id: child,
        userId: customerId,
        goal: 'checkout',
        status: 'COMPLETED',
        parentAgentId: completedRoot,
        busId: completedRoot,
        depth: 1,
        createdAt: at,
      },
    });
    // Each purchase gets a distinct amount so the result identifies it.
    const spend = async (
      totalCents: number,
      userId: string,
      agentId: string,
      provider: string,
      extra: {
        stripeLivemode?: boolean;
        status?: 'CLEARED' | 'VOIDED';
        lineItemsJson?: Record<string, unknown>;
      } = {}
    ) => {
      const id = randomUUID();
      purchaseIds.push(id);
      await prisma.purchaseSpend.create({
        data: {
          id,
          userId,
          agentId,
          provider,
          fingerprint: `gmv-case-${id}`,
          merchant: 'Merchant',
          lineItemsJson: extra.lineItemsJson ?? {},
          totalCents,
          status: extra.status ?? 'CLEARED',
          stripeLivemode: extra.stripeLivemode ?? false,
          createdAt: at,
        },
      });
    };
    await spend(101, customerId, child, 'agentcard', { stripeLivemode: true }); // live card
    await spend(102, customerId, completedRoot, 'agentcard'); // test-mode card
    await spend(103, customerId, completedRoot, 'agentcard', {
      stripeLivemode: true,
      status: 'VOIDED',
    });
    await spend(104, customerId, completedRoot, 'order_confirmation'); // finished task
    await spend(105, customerId, runningRoot, 'order_confirmation'); // unfinished task
    await spend(106, customerId, benchmarkRoot, 'order_confirmation');
    await spend(107, coreId, coreRoot, 'order_confirmation'); // core team
    await spend(108, fixtureId, fixtureRoot, 'order_confirmation');
    await spend(109, customerId, archivedRoot, 'order_confirmation'); // archived after checkout
    // Order-history lookup (prod 2026-09-28): one entry of a multi-order list.
    await spend(110, customerId, completedRoot, 'order_confirmation', {
      lineItemsJson: {
        amountKey: 'items.0.order_total',
        sourceFields: { items: [{ order_total: '$1.10' }, { order_total: '$2.20' }] },
      },
    });
    // A single order wrapped in a one-entry list is still one checkout.
    await spend(111, customerId, completedRoot, 'order_confirmation', {
      lineItemsJson: { amountKey: 'result.0.total', sourceFields: { result: [{ total: 1.11 }] } },
    });

    const rows = await findProductGmvBetween(start, end);
    assert.deepEqual(
      rows.map((row) => row.totalCents).sort((a, b) => a - b),
      [101, 104, 107, 109, 111],
      'Only live card charges and single-checkout orders from tasks no longer running, by real people or the core team, are GMV'
    );
    assert.deepEqual(
      rows.filter((row) => row.coreTeam).map((row) => row.totalCents),
      [107],
      'The core teammate (phone match) is flagged so series.ts keeps them unsubscribed'
    );
  } finally {
    await prisma.purchaseSpend.deleteMany({
      where: { id: { in: purchaseIds } },
    });
    await prisma.agent.deleteMany({ where: { id: child } });
    await prisma.agent.deleteMany({ where: { id: { in: agents } } });
    await prisma.user.deleteMany({ where: { userId: { in: [customerId, coreId, fixtureId] } } });
  }
}
