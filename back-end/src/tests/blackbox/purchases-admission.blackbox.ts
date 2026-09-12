#!/usr/bin/env tsx
/** Real database admission races; external payment rails use the existing test providers. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseError } from '../../domains/purchases/errors';
import * as repo from '../../domains/purchases/repo';
import { mintPurchaseCard } from '../../domains/purchases/service';
import type { MintPurchaseInput } from '../../domains/purchases/types';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import type { CardProviderMintRequest } from '../../providers/card-provider';
import {
  FakeCardProvider,
  FakeWalletFundingProvider,
  ResumableFundingInProgressCardProvider,
  withFakeStripe,
} from './purchases.testkit';

config();
const users: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture did not reach ${label}`)), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fixture() {
  const userId = `purchase-admission-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeCustomerId: `cus_${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 86400000),
    },
  });
  const agent = await prisma.agent.create({
    data: { userId, goal: 'Purchase admission fixture', status: 'ACTIVE' },
  });
  const input: MintPurchaseInput = {
    userId,
    agentId: agent.id,
    fingerprint: `fp-${randomUUID()}`,
    merchant: 'Admission fixture',
    currency: 'USD',
    lineItems: [
      {
        name: 'Widget',
        productUrl: 'https://example.com/widget',
        rating: '',
        reviewCount: '',
        unitPriceCents: 1000,
        quantity: 1,
        lineTotalCents: 1000,
      },
    ],
    fees: [],
    subtotalCents: 1000,
    totalCents: 1000,
  };
  return { userId, agentId: agent.id, input };
}

function admissionError(error: unknown): boolean {
  return error instanceof PurchaseError && error.code === 'purchase_agent_unavailable';
}

async function rejectionBeforeExternalCalls(kind: 'sealed' | 'missing' | 'wrong-user') {
  const f = await fixture();
  if (kind === 'sealed')
    await prisma.agent.update({ where: { id: f.agentId }, data: { deletedAt: new Date() } });
  if (kind === 'missing') f.input.agentId = randomUUID();
  if (kind === 'wrong-user') f.input.agentId = (await fixture()).agentId;
  const card = new FakeCardProvider();
  const funding = new FakeWalletFundingProvider();
  await withFakeStripe(async (calls) => {
    await assert.rejects(mintPurchaseCard(f.input, card, funding), admissionError);
    assert.equal(card.mintCalls, 0);
    assert.equal(card.detailCalls, 0);
    assert.equal(calls.charges.length, 0);
    assert.equal(await prisma.purchaseSpend.count({ where: { userId: f.userId } }), 0);
  });
}

/** Observe the actual PostgreSQL wait behind our exact sealing transaction, without a timing guess. */
async function sealWins<T>(agentId: string, admit: () => Promise<T>): Promise<void> {
  const ready = deferred<number>();
  const release = deferred<void>();
  const seal = prisma.$transaction(
    async (tx) => {
      await lockAgentWorkflowGeneration(tx, agentId);
      await tx.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
      const [pid] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      ready.resolve(pid.pid);
      await release.promise;
    },
    { timeout: 10000 }
  );
  const blocker = await ready.promise;
  let finished = false;
  const admission = admit().then(
    (value) => {
      finished = true;
      return { value, error: undefined };
    },
    (error: unknown) => {
      finished = true;
      return { value: undefined, error };
    }
  );
  let waiting = false;
  try {
    const deadline = Date.now() + 5000;
    waiting = await retryWithBackoff(
      async () => {
        const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))
        ) AS waiting
      `;
        return row.waiting;
      },
      {
        maxRetries: 500,
        getBackoffDelayMs: () => 10,
        fixedDelays: Array.from({ length: 499 }, () => 10),
        isRetryable: () => false,
        shouldRetryResult: (observed) => !observed && !finished && Date.now() < deadline,
        component: 'PurchaseAdmissionFixture',
      }
    );
    assert.equal(
      finished,
      false,
      'purchase admission completed before the sealing transaction committed'
    );
    assert.equal(waiting, true, 'admission must wait behind the exact generation seal');
  } finally {
    release.resolve();
    await seal;
    await admission;
  }
  assert.ok(admissionError((await admission).error), 'the committed seal must reject admission');
}

async function createRace(direct = false) {
  const f = await fixture();
  await sealWins(f.agentId, () =>
    (direct ? repo.createPendingPurchase : repo.createPendingPurchaseWithLock)({
      userId: f.userId,
      agentId: f.agentId,
      fingerprint: f.input.fingerprint,
      canonicalFingerprint: f.input.fingerprint,
      merchant: f.input.merchant,
      lineItemsJson: {},
      totalCents: 1000,
    })
  );
  assert.equal(await prisma.purchaseSpend.count({ where: { agentId: f.agentId } }), 0);
}

async function resumeRace() {
  const f = await fixture();
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId: f.userId,
      agentId: f.agentId,
      fingerprint: f.input.fingerprint,
      merchant: f.input.merchant,
      lineItemsJson: {},
      totalCents: 1000,
      status: 'FUNDING_PENDING',
    },
  });
  await sealWins(f.agentId, () => repo.claimFundingPendingPurchase(purchase.id));
  assert.equal(
    (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } })).status,
    'FUNDING_PENDING'
  );
}

async function sealedFundingResume() {
  const f = await fixture();
  const card = new ResumableFundingInProgressCardProvider();
  await withFakeStripe(async (calls) => {
    await assert.rejects(
      mintPurchaseCard(f.input, card, new FakeWalletFundingProvider()),
      (error: unknown) =>
        error instanceof PurchaseError && error.code === 'agentcard_company_funding_in_progress'
    );
    const pending = await prisma.purchaseSpend.findFirstOrThrow({ where: { agentId: f.agentId } });
    assert.equal(pending.status, 'FUNDING_PENDING');
    await prisma.agent.update({ where: { id: f.agentId }, data: { deletedAt: new Date() } });
    const originalMints = card.mintCalls;
    const originalCharges = calls.charges.length;
    await assert.rejects(
      mintPurchaseCard(f.input, card, new FakeWalletFundingProvider()),
      admissionError
    );
    assert.equal(card.mintCalls, originalMints);
    assert.equal(calls.charges.length, originalCharges);
    assert.equal(
      (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: pending.id } })).status,
      'FUNDING_PENDING'
    );
  });
}

async function admittedMintRemainsVisibleWithoutHoldingSealLock() {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  class WaitingCard extends FakeCardProvider {
    async mintCard(request: CardProviderMintRequest) {
      entered.resolve();
      await release.promise;
      return super.mintCard(request);
    }
  }
  await withFakeStripe(async (calls) => {
    const mint = mintPurchaseCard(f.input, new WaitingCard(), new FakeWalletFundingProvider());
    try {
      await bounded(
        Promise.race([
          entered.promise,
          mint.then(() => {
            throw new Error('Mint completed before fixture barrier');
          }),
        ]),
        'mint provider barrier'
      );
      const pending = await prisma.purchaseSpend.findFirstOrThrow({
        where: { agentId: f.agentId },
      });
      assert.equal(pending.status, 'CHARGING');
      await prisma.$transaction(
        async (tx) => {
          await lockAgentWorkflowGeneration(tx, f.agentId);
          await tx.agent.update({ where: { id: f.agentId }, data: { deletedAt: new Date() } });
        },
        { timeout: 2000 }
      );
      assert.equal(
        (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: pending.id } })).status,
        'CHARGING'
      );
    } finally {
      release.resolve();
      await mint.catch(() => undefined);
    }
    const result = await mint;
    assert.equal(result.status, 'HELD');
    assert.equal(calls.charges.length, 1);
    const persisted = await prisma.purchaseSpend.findUniqueOrThrow({
      where: { id: result.purchaseId },
    });
    assert.equal(persisted.agentId, f.agentId);
    assert.equal(
      persisted.status,
      'HELD',
      'accepted work must remain visible for post-seal compensation'
    );
  });
}

async function legacyResumeAdoption() {
  const f = await fixture();
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId: f.userId,
      fingerprint: f.input.fingerprint,
      merchant: f.input.merchant,
      lineItemsJson: {},
      totalCents: 1000,
      status: 'FUNDING_PENDING',
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId: f.userId,
      amountCents: 1000,
      status: 'PENDING',
      currency: 'usd',
      idempotencyKey: `fund:${purchase.id}`,
    },
  });
  const claimed = await repo.claimFundingPendingPurchase(purchase.id, {
    userId: f.userId,
    agentId: f.agentId,
  });
  assert.equal(claimed?.status, 'CHARGING');
  assert.equal(claimed?.agentId, f.agentId);
  assert.equal(
    (await prisma.purchaseWalletFunding.findUniqueOrThrow({ where: { purchaseId: purchase.id } }))
      .agentId,
    f.agentId
  );
}

async function wrongResumeOwner() {
  const f = await fixture();
  const other = await fixture();
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId: f.userId,
      agentId: f.agentId,
      fingerprint: f.input.fingerprint,
      merchant: f.input.merchant,
      lineItemsJson: {},
      totalCents: 1000,
      status: 'FUNDING_PENDING',
    },
  });
  await assert.rejects(
    repo.claimFundingPendingPurchase(purchase.id, { userId: other.userId, agentId: other.agentId }),
    admissionError
  );
  assert.equal(
    (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: purchase.id } })).status,
    'FUNDING_PENDING'
  );
}

async function standalonePurchase() {
  const f = await fixture();
  delete f.input.agentId;
  await withFakeStripe(async () => {
    const result = await mintPurchaseCard(
      f.input,
      new FakeCardProvider(),
      new FakeWalletFundingProvider()
    );
    assert.equal(result.status, 'HELD');
    assert.equal(
      (await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: result.purchaseId } })).agentId,
      null
    );
  });
}

async function staleLegacyResumeCannotStealOwnership() {
  const f = await fixture();
  const secondAgent = await prisma.agent.create({
    data: {
      userId: f.userId,
      goal: 'Second admission fixture',
      status: 'ACTIVE',
    },
  });
  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId: f.userId,
      fingerprint: f.input.fingerprint,
      merchant: f.input.merchant,
      lineItemsJson: {},
      totalCents: 1000,
      status: 'FUNDING_PENDING',
    },
  });
  await prisma.purchaseWalletFunding.create({
    data: {
      purchaseId: purchase.id,
      userId: f.userId,
      amountCents: 1000,
      status: 'PENDING',
      currency: 'usd',
      idempotencyKey: `fund:${purchase.id}`,
    },
  });
  const ready = deferred<number>();
  const release = deferred<void>();
  const blockerTransaction = prisma.$transaction(
    async (tx) => {
      await lockAgentWorkflowGeneration(tx, secondAgent.id);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      ready.resolve(row.pid);
      await release.promise;
    },
    { timeout: 10000 }
  );
  const blocker = await bounded(ready.promise, 'second agent generation lock');
  let finished = false;
  const secondClaim = repo
    .claimFundingPendingPurchase(purchase.id, {
      userId: f.userId,
      agentId: secondAgent.id,
    })
    .then(
      (value) => {
        finished = true;
        return value;
      },
      (error: unknown) => {
        finished = true;
        throw error;
      }
    );
  try {
    const deadline = Date.now() + 5000;
    const waiting = await retryWithBackoff(
      async () => {
        const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))) AS waiting
      `;
        return row.waiting;
      },
      {
        maxRetries: 500,
        fixedDelays: Array.from({ length: 499 }, () => 10),
        isRetryable: () => false,
        shouldRetryResult: (observed) => !observed && !finished && Date.now() < deadline,
        component: 'PurchaseResumeOwnershipFixture',
      }
    );
    assert.ok(waiting && !finished, 'second caller must wait after reading legacy null ownership');
    const first = await repo.claimFundingPendingPurchase(purchase.id, {
      userId: f.userId,
      agentId: f.agentId,
    });
    assert.equal(first?.agentId, f.agentId);
    assert.equal(first?.status, 'CHARGING');
    // The provider's resumable failure hands the admitted attempt back to this state.
    await repo.updatePurchaseStatus(purchase.id, 'FUNDING_PENDING');
  } finally {
    release.resolve();
    await blockerTransaction;
    await secondClaim;
  }
  assert.equal(
    await secondClaim,
    null,
    'stale null-agent snapshot cannot authorize another provider retry'
  );
  const final = await prisma.purchaseSpend.findUniqueOrThrow({
    where: { id: purchase.id },
    include: { walletFunding: true },
  });
  assert.equal(final.agentId, f.agentId);
  assert.equal(final.walletFunding?.agentId, f.agentId);
  assert.equal(final.status, 'FUNDING_PENDING');
}

const cases: Array<[string, () => Promise<void>]> = [
  ...(['sealed', 'missing', 'wrong-user'] as const).map((kind): [string, () => Promise<void>] => [
    `${kind} agent cannot mint or retrieve a card`,
    () => rejectionBeforeExternalCalls(kind),
  ]),
  ['seal wins against a new purchase admission', () => createRace()],
  ['seal wins against direct repository admission', () => createRace(true)],
  ['seal wins against a funding-resume claim', resumeRace],
  ['sealed funding retry cannot create another provider effect', sealedFundingResume],
  ['legacy null-agent funding is attributed before resume', legacyResumeAdoption],
  [
    'stale legacy resume cannot steal ownership after requeue',
    staleLegacyResumeCannotStealOwnership,
  ],
  ['funding claim rejects a different owner', wrongResumeOwner],
  ['standalone user purchase remains supported', standalonePurchase],
  [
    'accepted mint stays visible and holds no generation lock during provider I/O',
    admittedMintRemainsVisibleWithoutHoldingSealLock,
  ],
];

async function main() {
  let failures = 0;
  try {
    for (const [name, test] of cases) {
      try {
        await test();
        console.log(`PASS ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId: { in: users } } });
    await prisma.agent.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { userId: { in: users } } });
    await prisma.$disconnect();
  }
  assert.equal(failures, 0, `${failures} purchase admission cases failed`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
