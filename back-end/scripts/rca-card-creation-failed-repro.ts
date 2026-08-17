/**
 * RCA owning-boundary repro for agent 500c444d-a5ff-4a35-9b08-3b888489f3df.
 *
 * Prod evidence: Org MCP create_card returns status=error
 * `create_card failed: card_creation_failed` for the purchase idempotency key
 * (replay of purchase:b3e6de0e-… still returns that terminal failure; a fresh
 * key on the same cardholder succeeds). Mint previously rewrote the untyped
 * error into funding-in-progress and silently retried for ~10 minutes.
 *
 * Exit 1 = bug present (rewrite happened). Exit 0 = fail-closed.
 */
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus } from '@prisma/client';
import { mintPurchaseCard } from '../src/domains/purchases/service';
import { PurchaseError } from '../src/domains/purchases/errors';
import { prisma } from '../src/providers/database';
import { AgentCardOrgMcpProvider } from '../src/providers/card-provider/agentcard-org-mcp';
import {
  FakeWalletFundingProvider,
  withFakeStripe,
} from '../src/tests/blackbox/purchases.testkit';
import { assertLocalDatabase } from '../src/tests/blackbox/assertLocalDatabase';

assertLocalDatabase();

async function expectPurchaseError(fn: () => Promise<unknown>): Promise<PurchaseError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PurchaseError) return error;
    throw error;
  }
  throw new Error('expected PurchaseError');
}

async function main(): Promise<void> {
  const userId = `rca-card-fail-${randomUUID()}`;
  const fingerprint = `card-creation-failed-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.subscription.create({
    data: {
      userId,
      subscriptionTier: 1,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeCustomerId: `cus_${randomUUID()}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  // Match the live AgentCard structured error for a poisoned idempotency key.
  const provider = new AgentCardOrgMcpProvider('cardholder-ok', async (name) => {
    if (name === 'create_card') {
      return {
        isError: true,
        structuredContent: {
          status: 'error',
          message: 'create_card failed: card_creation_failed',
        },
      };
    }
    throw new Error(`unexpected tool ${name}`);
  });

  const error = await withFakeStripe(async () =>
    expectPurchaseError(() =>
      mintPurchaseCard(
        {
          userId,
          fingerprint,
          merchant: 'Test Merchant',
          currency: 'USD',
          lineItems: [{ label: 'Widget', amountCents: 1000 }],
          fees: [{ label: 'Tax', amountCents: 80 }],
          subtotalCents: 1000,
          totalCents: 1000,
        } as never,
        provider,
        new FakeWalletFundingProvider()
      )
    )
  );

  const rewritten =
    error.code === 'agentcard_company_funding_in_progress' ||
    /funding outcome is not confirmed/i.test(error.message);

  const purchase = await prisma.purchaseSpend.findFirst({
    where: { userId, fingerprint },
    include: { walletFunding: true },
  });

  const payload = {
    IS_FUNDING_REWRITE: rewritten,
    errorCode: error.code ?? null,
    errorMessage: error.message,
    purchaseStatus: purchase?.status ?? null,
    walletFunding: purchase?.walletFunding?.status ?? null,
  };
  console.log(JSON.stringify(payload, null, 2));

  await prisma.purchaseWalletFunding
    .deleteMany({ where: { purchaseId: purchase?.id } })
    .catch(() => undefined);
  await prisma.purchaseSpend.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.subscription.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.user.delete({ where: { userId } }).catch(() => undefined);
  await prisma.$disconnect();

  if (rewritten) {
    console.error(
      'FAIL: create_card failed: card_creation_failed was rewritten as funding-in-progress'
    );
    process.exit(1);
  }
  if (error.code !== 'agentcard_card_creation_failed') {
    console.error(`FAIL: expected agentcard_card_creation_failed, got ${error.code}`);
    process.exit(1);
  }
  if (purchase?.status !== PurchaseSpendStatus.FAILED) {
    console.error(`FAIL: expected purchase FAILED, got ${purchase?.status}`);
    process.exit(1);
  }
  console.error('PASS: card_creation_failed stayed fail-closed (not funding rewrite)');
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(2);
});
