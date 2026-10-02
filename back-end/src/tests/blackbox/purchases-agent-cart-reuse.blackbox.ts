#!/usr/bin/env tsx
/**
 * Same-agent held-card reuse when model-written line-item text drifts between two requests
 * for one cart (agent-payment-idempotent-abandonment: "Aurora Notebook" vs "Aurora Notebook (x1)").
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { cartPriceSignature, findSameAgentHeldCart } from '../../domains/purchases/agentCartReuse';
import * as purchasesService from '../../domains/purchases/service';
import type { MintPurchaseInput } from '../../domains/purchases/types';
import { prisma } from '../../providers/database';
import { assert, StubCardStateProvider } from './purchases.testkit';

config();

const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const MERCHANT = 'Rose Labs Test Payment';
const trackedUserIds = new Set<string>();

async function createUser(label: string): Promise<string> {
  const userId = `purchase-cart-reuse-${RUN_ID}-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  trackedUserIds.add(userId);
  return userId;
}

async function createAgent(userId: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: { userId, goal: 'same-agent cart reuse' },
    select: { id: true },
  });
  return agent.id;
}

function receipt(
  nameSuffix: string,
  origin: string,
  prices: [number, number, number] = [1200, 900, 1500]
) {
  const names = ['Aurora Notebook', 'Ceramic Mug', 'Canvas Tote'];
  const lineItems = names.map((name, index) => ({
    name: `${name}${nameSuffix}`,
    imageUrl: `https://placehold.co/320x220/png?text=${encodeURIComponent(name)}`,
    productUrl: `${origin}/${name.toLowerCase().replace(/ /g, '-')}`,
    rating: '4.8 stars',
    reviewCount: '1,284 reviews',
    unitPriceCents: prices[index],
    quantity: 1,
    lineTotalCents: prices[index],
  }));
  return {
    currency: 'USD',
    lineItems,
    fees: [
      { label: 'Tax', amountCents: 297 },
      { label: 'Shipping', amountCents: 499 },
    ],
    subtotalCents: 3600,
    totalCents: 4396,
  };
}

async function createHeldPurchase(userId: string, agentId: string, cardId: string) {
  return prisma.purchaseSpend.create({
    data: {
      userId,
      agentId,
      fingerprint: `first-request-${randomUUID()}`,
      canonicalFingerprint: `first-request-${randomUUID()}`,
      merchant: MERCHANT,
      lineItemsJson: receipt('', 'https://shop.test/p'),
      totalCents: 4396,
      status: PurchaseSpendStatus.HELD,
      cardId,
    },
  });
}

function retryInput(userId: string, agentId: string): MintPurchaseInput {
  return {
    userId,
    agentId,
    fingerprint: `second-request-${randomUUID()}`,
    merchant: MERCHANT,
    ...receipt(' (x1)', 'https://shop.test'),
  };
}

function testSignatureIgnoresModelText(): void {
  const bare = cartPriceSignature(receipt('', 'https://shop.test/p'), 4396);
  const drifted = cartPriceSignature(receipt(' - 1 each', 'https://shop.test'), 4396);
  assert(bare !== null && bare === drifted, 'names and product URLs must not change the signature');
  const reSplit = cartPriceSignature(receipt('', 'https://shop.test/p', [1300, 800, 1500]), 4396);
  assert(reSplit !== bare, 'a different per-item price split with the same total must differ');
  assert(
    cartPriceSignature({ ...receipt('', 'https://shop.test/p'), fees: [] }, 4396) !== bare,
    'different fee amounts must differ'
  );
  assert(
    cartPriceSignature({ currency: 'USD', lineItems: [{ name: 'x' }], fees: [] }, 100) === null,
    'items without amounts must not produce a signature'
  );
}

async function testMintReusesSameAgentHeldCard(): Promise<void> {
  const userId = await createUser('reuse');
  const agentId = await createAgent(userId);
  const cardId = `held-card-${randomUUID()}`;
  const held = await createHeldPurchase(userId, agentId, cardId);
  const provider = new StubCardStateProvider({
    status: 'OPEN',
    balanceCents: 4396,
    pan: '4242424242422391',
  });

  const result = await purchasesService.mintPurchaseCard(retryInput(userId, agentId), provider);

  assert(result.purchaseId === held.id, 'drifted retry must reuse the held purchase');
  assert(
    result.cardId === cardId && result.last4 === '2391',
    'drifted retry must return the held card'
  );
  assert(provider.getDetailsCalls >= 1, 'reuse must confirm the held card is still live');
  assert(
    (await prisma.purchaseSpend.count({ where: { userId } })) === 1,
    'drifted retry must not open a second purchase'
  );
}

async function testNoReuseAcrossAgentsOrCarts(): Promise<void> {
  const userId = await createUser('isolation');
  const agentId = await createAgent(userId);
  const otherAgentId = await createAgent(userId);
  await createHeldPurchase(userId, agentId, `held-card-${randomUUID()}`);
  const since = new Date(Date.now() - 60 * 60 * 1000);

  assert(
    (await findSameAgentHeldCart(retryInput(userId, agentId), since)) !== null,
    'the owning agent must match its held cart'
  );
  assert(
    (await findSameAgentHeldCart(retryInput(userId, otherAgentId), since)) === null,
    'another agent of the same user must never receive the held card'
  );
  assert(
    (await findSameAgentHeldCart({ ...retryInput(userId, agentId), agentId: undefined }, since)) ===
      null,
    'requests without an agent must not match'
  );
  assert(
    (await findSameAgentHeldCart(
      { ...retryInput(userId, agentId), merchant: 'Another Shop' },
      since
    )) === null,
    'a different merchant must not match'
  );
  assert(
    (await findSameAgentHeldCart(
      {
        ...retryInput(userId, agentId),
        ...receipt('', 'https://shop.test/p', [1300, 800, 1500]),
      },
      since
    )) === null,
    'a different per-item price split must not match'
  );
  await prisma.purchaseSpend.updateMany({
    where: { userId },
    data: { status: PurchaseSpendStatus.CLEARED },
  });
  assert(
    (await findSameAgentHeldCart(retryInput(userId, agentId), since)) === null,
    'a consumed purchase must not match'
  );
}

async function main(): Promise<void> {
  try {
    testSignatureIgnoresModelText();
    await testMintReusesSameAgentHeldCard();
    await testNoReuseAcrossAgentsOrCarts();
    console.log('PASS same-agent held-card reuse across model-written line-item drift');
  } finally {
    for (const userId of trackedUserIds) {
      await prisma.agent.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { userId } });
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
