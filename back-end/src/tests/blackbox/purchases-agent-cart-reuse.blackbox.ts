#!/usr/bin/env tsx
/**
 * Same-agent held-card reuse when model-written line-item text drifts between two requests
 * for one cart (agent-payment-idempotent-abandonment: "Aurora Notebook" vs "Aurora Notebook (x1)").
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { createApprovedPurchaseSelector } from '../../domains/purchases/approvalReuse';
import { canonicalStoredPurchaseFingerprint } from '../../domains/purchases/fingerprint';
import type { CompletionChunk, CompletionOptions } from '../../providers/rose/types';
import { cartPriceSignature, findSameAgentHeldCart } from '../../domains/purchases/agentCartReuse';
import * as purchasesService from '../../domains/purchases/service';
import type { MintPurchaseInput } from '../../domains/purchases/types';
import { prisma } from '../../providers/database';
import { assert, StubCardStateProvider } from './purchases.testkit';
import { testIncompleteConsentCannotGrantReuse } from './purchases-incomplete-consent.testkit';
import { testReuseMintProviderFailureIsTyped } from './purchases-reuse-provider-error.testkit';
import {
  runApprovalReuseBenchmark,
  testApprovalBenchmarkGrading,
} from './purchases-approval-reuse.benchmark';

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

async function testApprovalLookupRecognizesCapturedRetry(): Promise<void> {
  const captured = JSON.parse(
    readFileSync(
      new URL('../fixtures/approval-retry-chatgpt-receipts.json', import.meta.url),
      'utf8'
    )
  );
  const userId = await createUser('approval-retry');
  const agentId = await createAgent(userId);
  const held = await prisma.purchaseSpend.create({
    data: {
      userId,
      agentId,
      merchant: captured.approved.merchant,
      fingerprint: captured.approved.fingerprint,
      canonicalFingerprint: captured.approved.fingerprint,
      lineItemsJson: captured.approved,
      totalCents: captured.approved.totalCents,
      status: PurchaseSpendStatus.HELD,
      cardId: `held-${randomUUID()}`,
    },
  });
  const provider = new StubCardStateProvider({
    status: 'OPEN',
    balanceCents: 50000,
    pan: '4242424242421372',
  });
  let semanticCalls = 0;
  const selectEquivalent = async (
    candidates: Array<{ id: string }>,
    requested: MintPurchaseInput
  ): Promise<string | null> => {
    semanticCalls += 1;
    assert(
      candidates.length === 1 && candidates[0].id === held.id,
      'semantic check must receive only this agent’s candidate'
    );
    assert(
      requested.lineItems[0].name === captured.retry.lineItems[0].name,
      'replay must retain captured product wording'
    );
    return held.id;
  };
  const input = { ...captured.retry, userId, agentId };
  const result = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
    userId,
    input.fingerprint,
    provider,
    new Date(),
    input,
    selectEquivalent,
  ]);
  assert(
    result.reusable === true,
    'captured semantic retry must reuse prior approval before prompting'
  );
  assert(
    result.purchase?.id === held.id,
    'lookup must bind reuse to the original approved purchase'
  );
  assert(
    result.purchase?.fingerprint === held.fingerprint,
    'mint must receive original fingerprint'
  );
  assert(semanticCalls === 1, 'text drift requires one bounded semantic comparison');
  assert(provider.getDetailsCalls === 1, 'approval reuse must verify card liveness');

  const denied = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
    userId,
    input.fingerprint,
    provider,
    new Date(),
    input,
    async () => null,
  ]);
  assert(denied.reusable === false, 'equal-price different products require fresh approval');
  const foreign = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
    userId,
    input.fingerprint,
    provider,
    new Date(),
    { ...input, agentId: await createAgent(userId) },
    selectEquivalent,
  ]);
  assert(foreign.reusable === false, 'semantic consent must never cross agents');

  let requestedOptions: CompletionOptions | undefined;
  let responseText = JSON.stringify({ purchaseId: held.id });
  const selector = createApprovedPurchaseSelector(async (options) => {
    requestedOptions = options;
    return (async function* (): AsyncGenerator<CompletionChunk> {
      yield {
        choices: [{ index: 0, delta: { content: responseText } }],
        requested_model: 'rose-labs/rose-1-flash',
        actual_model: 'fixture-model',
        pool_name: 'flash',
        pool_size: 1,
      };
    })();
  });
  assert(
    (await selector([held], input)) === held.id,
    'valid model decision must retain original purchase id'
  );
  const noisyRetry = {
    ...input,
    lineItems: [
      {
        ...input.lineItems[0],
        imageUrl: `data:image/png;base64,${'A'.repeat(100_000)}`,
        rating: 'untrusted-review-rating',
        reviewCount: 'untrusted-review-count',
      },
    ],
  };
  assert((await selector([held], noisyRetry)) === held.id, 'display metadata must not alter reuse');
  const modelRequest = JSON.parse(String(requestedOptions?.messages[1].content));
  assert(
    JSON.stringify(modelRequest).length < 5000,
    'large image metadata must not consume semantic approval context'
  );
  assert(
    !JSON.stringify(modelRequest).includes('untrusted-review-') &&
      !JSON.stringify(modelRequest).includes(input.fingerprint) &&
      !JSON.stringify(modelRequest).includes(userId),
    'irrelevant display metadata and internal request identity must stay out of model context'
  );
  assert(
    modelRequest.approved[0].receipt.lineItems[0].name === captured.approved.lineItems[0].name,
    'send full original item wording to semantic comparison'
  );
  assert(
    modelRequest.requested.lineItems[0].productUrl === captured.retry.lineItems[0].productUrl,
    'send full captured retry URL'
  );
  responseText = '{"purchaseId":null}';
  assert(
    (await selector([held], input)) === null,
    'uncertainty or material differences must require approval'
  );
  responseText = '{"purchaseId":"foreign-purchase"}';
  let invalidRejected = false;
  try {
    await selector([held], input);
  } catch {
    invalidRejected = true;
  }
  assert(invalidRejected, 'unrecognized model purchase id must fail closed');
  responseText = 'not json';
  let malformedRejected = false;
  try {
    await selector([held], input);
  } catch {
    malformedRejected = true;
  }
  assert(malformedRejected, 'malformed decision must never grant consent');

  semanticCalls = 0;
  const changed = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
    userId,
    input.fingerprint,
    provider,
    new Date(),
    { ...input, totalCents: 50100 },
    selectEquivalent,
  ]);
  assert(
    changed.reusable === false && semanticCalls === 0,
    'changed amount must reject before model call'
  );
  const exactForeign = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
    userId,
    held.fingerprint,
    provider,
    new Date(),
    { ...input, agentId: await createAgent(userId) },
    selectEquivalent,
  ]);
  assert(exactForeign.reusable === false, 'exact-fingerprint consent cannot cross agents either');
  const expired = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
    userId,
    input.fingerprint,
    provider,
    new Date(Date.now() + 25 * 3600000),
    input,
    selectEquivalent,
  ]);
  assert(
    expired.reusable === false && semanticCalls === 0,
    'expired consent must not reach semantic model'
  );
  const usageCompletion = async () =>
    (async function* (): AsyncGenerator<CompletionChunk> {
      yield {
        choices: [{ index: 0, delta: { content: 'not json' } }],
        requested_model: 'rose-labs/rose-1-flash',
        actual_model: 'fixture-model',
        pool_name: 'flash',
        pool_size: 1,
        usage: { prompt_tokens: 37, completion_tokens: 11, total_tokens: 48 },
      };
    })();
  let chargedFailure: unknown;
  try {
    await Reflect.apply(purchasesService.lookupPurchase, undefined, [
      userId,
      input.fingerprint,
      provider,
      new Date(),
      input,
      undefined,
      usageCompletion,
    ]);
  } catch (error) {
    chargedFailure = error;
  }
  assert(
    chargedFailure instanceof purchasesService.PurchaseError,
    'invalid billed comparison must remain a lookup error'
  );
  const failedUsage = (chargedFailure as purchasesService.PurchaseError).details
    .usageItems as Array<Record<string, unknown>>;
  assert(
    failedUsage.length === 1 &&
      failedUsage[0].input_tokens === 37 &&
      failedUsage[0].output_tokens === 11,
    'terminal comparison error must retain actual model usage exactly once'
  );
  const successfulCompletion = async () =>
    (async function* (): AsyncGenerator<CompletionChunk> {
      yield {
        choices: [{ index: 0, delta: { content: JSON.stringify({ purchaseId: held.id }) } }],
        requested_model: 'rose-labs/rose-1-flash',
        actual_model: 'fixture-model',
        pool_name: 'flash',
        pool_size: 1,
        usage: { prompt_tokens: 37, completion_tokens: 11, total_tokens: 48 },
      };
    })();
  const brokenCard = new StubCardStateProvider({
    status: 'OPEN',
    balanceCents: 50000,
    pan: '4242424242421372',
  });
  brokenCard.getDetails = async () => {
    throw new Error('provider unavailable');
  };
  let cardFailure: unknown;
  try {
    await Reflect.apply(purchasesService.lookupPurchase, undefined, [
      userId,
      input.fingerprint,
      brokenCard,
      new Date(),
      input,
      undefined,
      successfulCompletion,
    ]);
  } catch (error) {
    cardFailure = error;
  }
  assert(
    cardFailure instanceof purchasesService.PurchaseError &&
      (cardFailure.details.usageItems as unknown[]).length === 1,
    'card provider failure after comparison must retain usage without approval'
  );
  const reusedCard = await purchasesService.mintPurchaseCard(
    { ...input, fingerprint: held.fingerprint, reusePurchaseId: held.id },
    provider
  );
  assert(
    reusedCard.purchaseId === held.id,
    'reuse-only mint must return exactly the approved purchase'
  );
  const unavailable = new StubCardStateProvider({
    status: 'CLOSED',
    balanceCents: 0,
    pan: '4242424242421372',
  });
  let approvalRequired = false;
  try {
    await purchasesService.mintPurchaseCard(
      { ...input, fingerprint: held.fingerprint, reusePurchaseId: held.id },
      unavailable
    );
  } catch (error) {
    approvalRequired =
      error instanceof purchasesService.PurchaseError &&
      error.code === 'purchase_approval_required';
  }
  assert(
    approvalRequired,
    'closed-card race after lookup must require approval before any new funding'
  );
  assert(
    (await prisma.purchaseSpend.count({ where: { userId } })) === 1,
    'reuse-only mint must never open a second purchase'
  );
  await prisma.purchaseSpend.update({
    where: { id: held.id },
    data: { status: PurchaseSpendStatus.HELD },
  });
  const closed = new StubCardStateProvider({
    status: 'CLOSED',
    balanceCents: 0,
    pan: '4242424242421372',
  });
  const consumed = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
    userId,
    input.fingerprint,
    closed,
    new Date(),
    input,
    selectEquivalent,
  ]);
  assert(consumed.reusable === false, 'consumed card must never autoapprove or duplicate payment');
}

async function testCanonicalKeyDoesNotEstablishConsent(): Promise<void> {
  const cases = JSON.parse(
    readFileSync(new URL('../fixtures/approval-reuse-adversarial.json', import.meta.url), 'utf8')
  ).filter((example: { batch: number }) => example.batch === 6);
  assert(cases.length === 5, 'receipt-boundary batch must remain frozen at five cases');
  const failures: string[] = [];
  for (const example of cases) {
    const userId = await createUser(example.id);
    const agentId = await createAgent(userId);
    const approved = example.approved[0].receipt;
    const fingerprint = canonicalStoredPurchaseFingerprint({
      userId,
      merchant: approved.merchant,
      lineItemsJson: approved,
      totalCents: approved.totalCents,
    });
    const input: MintPurchaseInput = {
      ...example.requested,
      userId,
      agentId,
      fingerprint: fingerprint!,
    };
    assert(fingerprint !== null, 'approved financial identity must be valid');
    assert(
      canonicalStoredPurchaseFingerprint({
        userId,
        merchant: input.merchant,
        lineItemsJson: input,
        totalCents: input.totalCents,
      }) === fingerprint,
      'fixture must reach the colliding canonical-key path'
    );
    const held = await prisma.purchaseSpend.create({
      data: {
        userId,
        agentId,
        merchant: approved.merchant,
        fingerprint: fingerprint!,
        canonicalFingerprint: fingerprint,
        lineItemsJson: approved,
        totalCents: approved.totalCents,
        status: PurchaseSpendStatus.HELD,
        cardId: `held-${randomUUID()}`,
      },
    });
    let calls = 0;
    const provider = new StubCardStateProvider({
      status: 'OPEN',
      balanceCents: 2400,
      pan: '4242424242421372',
    });
    const result = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
      userId,
      fingerprint,
      provider,
      new Date(),
      input,
      async (candidates: Array<{ id: string }>) => {
        calls += 1;
        assert(
          candidates.length === 1 && candidates[0].id === held.id,
          'scope must retain the original candidate'
        );
        return example.expectedPurchaseId === null ? null : held.id;
      },
    ]);
    const expected = example.expectedPurchaseId !== null;
    const outcome =
      result.reusable === expected ? (expected ? 'TP' : 'TN') : result.reusable ? 'FP' : 'FN';
    console.log(`CONSENT_BOUNDARY ${example.id} ${outcome} semanticCalls=${calls}`);
    if (result.reusable !== expected || calls !== 1)
      failures.push(`${example.id}: ${outcome}, semanticCalls=${calls}`);

    // Full consent fields identical: avoid a model call on an unchanged receipt.
    const exact = await Reflect.apply(purchasesService.lookupPurchase, undefined, [
      userId,
      fingerprint,
      provider,
      new Date(),
      { ...input, ...approved },
      async () => {
        throw new Error('identical consent must not use model context');
      },
    ]);
    assert(exact.reusable === true, 'identical complete consent fields must retain exact reuse');
  }
  assert(
    failures.length === 0,
    `Canonical key is insufficient for consent: ${failures.join('; ')}`
  );
}

async function main(): Promise<void> {
  try {
    testApprovalBenchmarkGrading();
    if (process.env.APPROVAL_REUSE_BENCH_BATCH !== undefined) {
      await runApprovalReuseBenchmark();
      return;
    }
    await testIncompleteConsentCannotGrantReuse();
    await testCanonicalKeyDoesNotEstablishConsent();
    await testApprovalLookupRecognizesCapturedRetry();
    testSignatureIgnoresModelText();
    await testMintReusesSameAgentHeldCard();
    await testReuseMintProviderFailureIsTyped();
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
