#!/usr/bin/env tsx

/**
 * Structured-output GMV ledger: paid orders with amount + confirmation id
 * land in PurchaseSpend without double-counting AgentCard mint rows.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus } from '@prisma/client';
import 'dotenv/config';

import {
  ORDER_CONFIRMATION_PROVIDER,
  recordStructuredGmv,
} from '../../domains/purchases/structuredGmv';
import { prisma } from '../../providers/database';

async function withUser(run: (userId: string) => Promise<void>): Promise<void> {
  const userId = `structured-gmv-unit-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    await run(userId);
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { userId } }).catch(() => undefined);
  }
}

async function seedAgent(userId: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: { userId, goal: 'structured gmv unit test' },
  });
  return agent.id;
}

async function main(): Promise<void> {
  await withUser(async (userId) => {
    const agentId = await seedAgent(userId);
    const first = await recordStructuredGmv({
      userId,
      agentId,
      structured: {
        merchant: 'Blue Bottle Coffee',
        checkout_total: '$18.50',
        order_confirmation_id: 'BB-UNIT-001',
      },
      source: 'unit.test',
    });
    assert.equal(first.status, 'recorded');
    if (first.status !== 'recorded') throw new Error('expected recorded');
    assert.equal(first.created, true);

    const row = await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: first.purchaseId } });
    assert.equal(row.provider, ORDER_CONFIRMATION_PROVIDER);
    assert.equal(row.status, PurchaseSpendStatus.CLEARED);
    assert.equal(row.totalCents, 1850);
    assert.equal(row.merchant, 'Blue Bottle Coffee');

    const second = await recordStructuredGmv({
      userId,
      agentId,
      structured: {
        merchant: 'Blue Bottle Coffee',
        checkout_total: '$18.50',
        order_confirmation_id: 'BB-UNIT-001',
      },
    });
    assert.equal(second.status, 'recorded');
    if (second.status !== 'recorded') throw new Error('expected recorded');
    assert.equal(second.created, false);
    assert.equal(second.purchaseId, first.purchaseId);
  });

  await withUser(async (userId) => {
    const agentId = await seedAgent(userId);
    await prisma.purchaseSpend.create({
      data: {
        userId,
        agentId,
        fingerprint: `agentcard-${agentId}`,
        merchant: 'Blick',
        lineItemsJson: { lineItems: [], totalCents: 1200 },
        totalCents: 1200,
        status: PurchaseSpendStatus.HELD,
        provider: 'agentcard',
      },
    });

    const skipped = await recordStructuredGmv({
      userId,
      agentId,
      structured: {
        merchant: 'Blick',
        total_cents: 1200,
        order_id: 'BLICK-CONF-99',
      },
    });
    assert.deepEqual(skipped, {
      status: 'skipped',
      reason: 'agentcard_purchase_exists',
    });
  });

  await withUser(async (userId) => {
    const skipped = await recordStructuredGmv({
      userId,
      structured: { checkout_total: '$10.00' },
    });
    assert.deepEqual(skipped, {
      status: 'skipped',
      reason: 'missing_amount_or_confirmation',
    });

    const boundary = await recordStructuredGmv({
      userId,
      structured: {
        checkout_total: 10,
        order_id: 'ORD-BOUNDARY',
        order_placed: false,
      },
    });
    assert.deepEqual(boundary, {
      status: 'skipped',
      reason: 'missing_amount_or_confirmation',
    });
  });

  process.stdout.write('purchases structured gmv: passed\n');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
