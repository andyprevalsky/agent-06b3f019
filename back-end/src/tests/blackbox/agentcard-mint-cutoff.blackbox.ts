#!/usr/bin/env tsx
/**
 * Black-box tests for the AgentCard mint HARD CUTOFF, pinned end-to-end through the real purchase
 * mint path and the real `Agent.isBenchmark` database bit.
 *
 * Production runs with `AGENTCARD_MINT_ENABLED` falsy and no benchmark override. In that state a
 * purchase must hand back the STATIC Rose Agent Card — one real, company-funded Brex card — for
 * EVERY human identity, admin or not. The admin branch is the easy one to get wrong: admins take a
 * different funding path (`issueAdminCompanyCard`, company-funded, no personal Stripe hold), and it
 * would be easy for that branch to drift onto a real AgentCard mint without anyone noticing.
 *
 * The one identity that MUST reach a real AgentCard mint is a benchmark agent. That override is
 * deliberately request-scoped (the durable `Agent.isBenchmark` row), because production shares one
 * backend process between real users and the benchmark harness. It is load-bearing in the other
 * direction too: the static card is a REAL shared Brex card with a $50/week cap, so an eval that
 * fell through to it would spend the company's card.
 *
 * Companion unit test: `src/tests/unit/agentcard-static-cutoff.test.ts` covers provider mechanics
 * (flag parsing, credential injection, id validation) with a stubbed benchmark resolver. This file
 * covers the ROUTING decision with nothing stubbed but Stripe and wallet funding: the card provider
 * is resolved for real and `isBenchmarkAgent` reads a real row.
 *
 * Every assertion here fails if the behaviour is inverted.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  AgentCardRoutingProvider,
  StaticRoseAgentCardProvider,
  agentCardMintEnabled,
  createCardProvider,
  createCardProviderForAgent,
} from '../../providers/card-provider';
import { ROSE_AGENT_CARD_ID } from '../../providers/card-provider/static-card';
import * as purchasesService from '../../domains/purchases/service';
import { ADMIN_USER_IDS, isAdminUser } from '../../utils/adminAccess';
import { assert, FakeWalletFundingProvider, withFakeStripe } from './purchases.testkit';

config();

const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

/** A hardcoded ADMIN_USER_IDS entry — Andy Prevalsky, a real synced user (never deleted here). */
const ADMIN_USER_ID = [...ADMIN_USER_IDS][0];

/** Test-only Rose Agent Card credentials. The real Brex PAN is never read by this suite. */
const TEST_CARD = { pan: '4111111111111111', cvv: '321', expiry: '11/30', pin: '4242' };

const MANAGED_ENV_KEYS = [
  'AGENTCARD_MINT_ENABLED',
  'BENCHMARK_MODE',
  'BENCHMARK_ISOLATED_RUN',
  'ROSE_AGENT_CARD_PAN',
  'ROSE_AGENT_CARD_CVV',
  'ROSE_AGENT_CARD_EXPIRY',
  'ROSE_AGENT_CARD_PIN',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of MANAGED_ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of MANAGED_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

/** Production's default: the cutoff is ACTIVE — no mint flag, no benchmark-mode override. */
function setProductionCutoffEnv(): void {
  delete process.env.AGENTCARD_MINT_ENABLED;
  delete process.env.BENCHMARK_MODE;
  delete process.env.BENCHMARK_ISOLATED_RUN;
  process.env.ROSE_AGENT_CARD_PAN = TEST_CARD.pan;
  process.env.ROSE_AGENT_CARD_CVV = TEST_CARD.cvv;
  process.env.ROSE_AGENT_CARD_EXPIRY = TEST_CARD.expiry;
  process.env.ROSE_AGENT_CARD_PIN = TEST_CARD.pin;
}

function mintBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    merchant: 'Rose Labs Test Payment',
    currency: 'USD',
    lineItems: [{ label: 'Widget', amountCents: 1000 }],
    fees: [],
    subtotalCents: 1000,
    totalCents: 1000,
    ...overrides,
  };
}

/**
 * A completed mint issued the STATIC card, not an AgentCard mint. Asserted from three independent
 * facts so no single one can be faked: the returned card id, the persisted purchase row, and the
 * absence of any wallet-funding row (a real AgentCard mint always persists card + company transfer
 * together; the static path deletes its pending marker because there is no transfer to reconcile).
 */
async function assertIssuedStaticCard(
  result: { cardId: string | null },
  userId: string,
  fingerprint: string,
  walletFundingProvider: FakeWalletFundingProvider,
  context: string
): Promise<void> {
  assert(
    result.cardId === ROSE_AGENT_CARD_ID,
    `${context}: expected the static Rose Agent Card (${ROSE_AGENT_CARD_ID}), got ${result.cardId}` +
      ' — an AgentCard mint escaped the production cutoff'
  );
  const row = await prisma.purchaseSpend.findFirst({
    where: { userId, fingerprint },
    orderBy: { createdAt: 'desc' },
  });
  assert(
    row?.cardId === ROSE_AGENT_CARD_ID,
    `${context}: purchase row should store the static card id, got ${row?.cardId}`
  );
  const fundingCount = await prisma.purchaseWalletFunding.count({
    where: { purchaseId: row?.id ?? '' },
  });
  assert(
    fundingCount === 0,
    `${context}: the static company card has no AgentCard company transfer, so no wallet funding ` +
      `may be recorded; found ${fundingCount}`
  );
  assert(
    walletFundingProvider.fundCalls.length === 0,
    `${context}: the static card must never fund an AgentCard wallet, got ` +
      `${walletFundingProvider.fundCalls.length} calls`
  );
}

async function mintingOffAdminGetsStaticRoseCard(): Promise<void> {
  setProductionCutoffEnv();
  assert(
    isAdminUser(ADMIN_USER_ID),
    `${ADMIN_USER_ID} must be an admin for this test to exercise the admin funding branch`
  );
  assert(!agentCardMintEnabled(), 'precondition: AgentCard minting must be OFF');

  await prisma.user.upsert({
    where: { userId: ADMIN_USER_ID },
    update: {},
    create: { userId: ADMIN_USER_ID, isAnonymous: true },
  });
  const agent = await prisma.agent.create({
    data: { userId: ADMIN_USER_ID, goal: 'mint cutoff blackbox (admin)', isBenchmark: false },
  });
  const fingerprint = `cutoff-admin-${RUN_ID}-${randomUUID()}`;
  const walletFundingProvider = new FakeWalletFundingProvider();

  try {
    const provider = await createCardProviderForAgent(ADMIN_USER_ID, agent.id);
    assert(
      provider instanceof StaticRoseAgentCardProvider,
      'an ADMIN on a non-benchmark agent must resolve the static Rose card provider'
    );
    assert(
      !(provider instanceof AgentCardRoutingProvider),
      'an ADMIN must NOT reach the AgentCard routing provider while minting is off'
    );

    await withFakeStripe(async (calls) => {
      // No cardProvider is injected: the production resolution path runs for real.
      const result = await purchasesService.mintPurchaseCard(
        mintBody({ userId: ADMIN_USER_ID, agentId: agent.id, fingerprint }) as never,
        undefined,
        walletFundingProvider
      );
      assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);
      await assertIssuedStaticCard(
        result,
        ADMIN_USER_ID,
        fingerprint,
        walletFundingProvider,
        'admin + minting off'
      );
      assert(
        calls.charges.length === 0,
        `an admin purchase is company-funded and must not authorize a Stripe hold, got ${calls.charges.length}`
      );
    });
  } finally {
    // Andy is a real synced user — drop only this run's rows, never the user.
    await prisma.purchaseSpend.deleteMany({ where: { userId: ADMIN_USER_ID, fingerprint } });
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
  console.log('PASS minting off + admin + non-benchmark agent issues the static Rose Agent Card');
}

async function mintingOffNonAdminGetsStaticRoseCard(): Promise<void> {
  setProductionCutoffEnv();
  const userId = `cutoff-user-${RUN_ID}-${randomUUID()}`;
  assert(!isAdminUser(userId), 'this test must exercise the NON-admin (charged) funding branch');

  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeCustomerId: `cus_cutoff_${RUN_ID}`,
      stripeSubscriptionId: `sub_cutoff_${RUN_ID}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  const agent = await prisma.agent.create({
    data: { userId, goal: 'mint cutoff blackbox (user)', isBenchmark: false },
  });
  const fingerprint = `cutoff-user-${RUN_ID}-${randomUUID()}`;
  const walletFundingProvider = new FakeWalletFundingProvider();

  try {
    const provider = await createCardProviderForAgent(userId, agent.id);
    assert(
      provider instanceof StaticRoseAgentCardProvider,
      'an ordinary user on a non-benchmark agent must resolve the static Rose card provider'
    );

    await withFakeStripe(async (calls) => {
      const result = await purchasesService.mintPurchaseCard(
        mintBody({ userId, agentId: agent.id, fingerprint }) as never,
        undefined,
        walletFundingProvider
      );
      assert(result.status === PurchaseSpendStatus.HELD, `expected HELD, got ${result.status}`);
      await assertIssuedStaticCard(
        result,
        userId,
        fingerprint,
        walletFundingProvider,
        'non-admin + minting off'
      );
      // Proves this really was the non-admin branch rather than the admin branch under a
      // different name: only `chargeAndIssueCard` authorizes and captures a personal hold.
      assert(
        calls.charges.length === 1,
        `a non-admin purchase must authorize exactly one Stripe hold, got ${calls.charges.length}`
      );
      assert(
        calls.captures.length === 1,
        `a non-admin purchase must capture its hold, got ${calls.captures.length}`
      );
    });
  } finally {
    await prisma.purchaseSpend.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { id: agent.id } });
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  console.log(
    'PASS minting off + non-admin + non-benchmark agent issues the static Rose Agent Card'
  );
}

async function mintingOffBenchmarkAgentGetsRealAgentCard(): Promise<void> {
  setProductionCutoffEnv();
  const userId = `cutoff-bench-${RUN_ID}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const benchmarkAgent = await prisma.agent.create({
    data: { userId, goal: 'mint cutoff blackbox (benchmark)', isBenchmark: true },
  });
  const ordinaryAgent = await prisma.agent.create({
    data: { userId, goal: 'mint cutoff blackbox (ordinary)', isBenchmark: false },
  });

  try {
    // The durable row — not process env — is what flips the override, so the same process serves
    // real users and the harness at once.
    assert(
      !agentCardMintEnabled(),
      'a benchmark AGENT must not flip the global mint flag; the override is request-scoped'
    );

    const benchmarkProvider = await createCardProviderForAgent(userId, benchmarkAgent.id);
    assert(
      benchmarkProvider instanceof AgentCardRoutingProvider,
      'an Agent.isBenchmark row must route to the REAL AgentCard provider — falling through to ' +
        'the static card would spend the shared company Brex card on an eval'
    );
    assert(
      !(benchmarkProvider instanceof StaticRoseAgentCardProvider),
      'a benchmark agent must never receive the static Rose Agent Card'
    );

    // Same user, same process, same env: only the durable bit differs.
    const ordinaryProvider = await createCardProviderForAgent(userId, ordinaryAgent.id);
    assert(
      ordinaryProvider instanceof StaticRoseAgentCardProvider,
      'a non-benchmark agent on the same user must stay behind the cutoff'
    );

    // A missing/blank agent id can never be mistaken for a benchmark.
    for (const agentId of [null, undefined, '', '   ']) {
      const provider = await createCardProviderForAgent(userId, agentId);
      assert(
        provider instanceof StaticRoseAgentCardProvider,
        `agentId ${JSON.stringify(agentId)} must resolve the static card, not a real mint`
      );
    }
  } finally {
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  console.log('PASS minting off + Agent.isBenchmark routes to a REAL AgentCard mint');
}

async function mintingOnGetsRealAgentCard(): Promise<void> {
  setProductionCutoffEnv();
  const userId = `cutoff-on-${RUN_ID}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const agent = await prisma.agent.create({
    data: { userId, goal: 'mint cutoff blackbox (flag on)', isBenchmark: false },
  });

  try {
    assert(
      (await createCardProviderForAgent(userId, agent.id)) instanceof StaticRoseAgentCardProvider,
      'control: with the flag off this identity is behind the cutoff'
    );

    process.env.AGENTCARD_MINT_ENABLED = 'true';
    assert(agentCardMintEnabled(), 'the flag must enable minting');
    assert(
      createCardProvider(userId) instanceof AgentCardRoutingProvider,
      'AGENTCARD_MINT_ENABLED must restore the real AgentCard provider'
    );
    const enabledProvider = await createCardProviderForAgent(userId, agent.id);
    assert(
      enabledProvider instanceof AgentCardRoutingProvider,
      'AGENTCARD_MINT_ENABLED must restore the real provider for a non-benchmark agent too'
    );
    assert(
      !(enabledProvider instanceof StaticRoseAgentCardProvider),
      'the static card must not be issued once minting is enabled'
    );

    // ADMIN identities follow the same switch — the cutoff is about the flag, never the role.
    assert(
      createCardProvider(ADMIN_USER_ID) instanceof AgentCardRoutingProvider,
      'an admin must reach the real provider when minting is enabled'
    );
  } finally {
    delete process.env.AGENTCARD_MINT_ENABLED;
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  console.log('PASS minting ON routes every identity to a REAL AgentCard mint');
}

async function main(): Promise<void> {
  const snapshot = snapshotEnv();
  try {
    await mintingOffAdminGetsStaticRoseCard();
    await mintingOffNonAdminGetsStaticRoseCard();
    await mintingOffBenchmarkAgentGetsRealAgentCard();
    await mintingOnGetsRealAgentCard();
  } finally {
    restoreEnv(snapshot);
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
