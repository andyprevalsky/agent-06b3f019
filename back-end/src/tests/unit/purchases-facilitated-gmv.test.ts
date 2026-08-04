#!/usr/bin/env tsx

/**
 * Facilitated GMV ledger: merchant card-on-file purchases must land in
 * PurchaseSpend without double-counting AgentCard mint rows.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus } from '@prisma/client';
import 'dotenv/config';

import {
  MERCHANT_SAVED_PROVIDER,
  recordFacilitatedGmv,
} from '../../domains/purchases/facilitatedGmv';
import { prisma } from '../../providers/database';

async function withUser(run: (userId: string) => Promise<void>): Promise<void> {
  const userId = `facilitated-gmv-unit-${randomUUID()}`;
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
    data: { userId, goal: 'facilitated gmv unit test' },
  });
  return agent.id;
}

async function main(): Promise<void> {
  await withUser(async (userId) => {
    const agentId = await seedAgent(userId);
    const first = await recordFacilitatedGmv({
      userId,
      agentId,
      merchant: 'Blue Bottle Coffee',
      totalCents: 1850,
      paymentMethod: 'Visa ending in 4242',
      domain: 'order.online',
      approvedAt: 1_720_000_000,
      lineItems: [{ title: 'Cortado' }],
      totals: { total: '$18.50' },
    });
    assert.equal(first.status, 'recorded');
    if (first.status !== 'recorded') throw new Error('expected recorded');
    assert.equal(first.created, true);

    const row = await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: first.purchaseId } });
    assert.equal(row.provider, MERCHANT_SAVED_PROVIDER);
    assert.equal(row.status, PurchaseSpendStatus.CLEARED);
    assert.equal(row.totalCents, 1850);
    assert.equal(row.merchant, 'Blue Bottle Coffee');

    const second = await recordFacilitatedGmv({
      userId,
      agentId,
      merchant: 'Blue Bottle Coffee',
      totalCents: 1850,
      domain: 'order.online',
      approvedAt: 1_720_000_000,
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

    const skipped = await recordFacilitatedGmv({
      userId,
      agentId,
      merchant: 'Blick',
      totalCents: 1200,
      domain: 'dickblick.com',
      approvedAt: 1_720_000_100,
    });
    assert.deepEqual(skipped, {
      status: 'skipped',
      reason: 'agentcard_purchase_exists',
    });
  });

  await withUser(async (userId) => {
    const skipped = await recordFacilitatedGmv({
      userId,
      merchant: '',
      totalCents: 100,
    });
    assert.deepEqual(skipped, { status: 'skipped', reason: 'missing_merchant' });

    const invalid = await recordFacilitatedGmv({
      userId,
      merchant: 'Shop',
      totalCents: -5,
    });
    assert.deepEqual(invalid, { status: 'skipped', reason: 'invalid_total_cents' });
  });

  process.stdout.write('purchases facilitated gmv: passed\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
