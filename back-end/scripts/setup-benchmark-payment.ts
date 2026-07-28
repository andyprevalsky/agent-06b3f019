import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { BENCHMARK_PAYMENT_LIFECYCLE_USER_ID } from '../src/domains/purchases/config';
import { isAdminUser } from '../src/utils/adminAccess';
import { ensureAgentCardSandboxFloat } from '../src/providers/agentcard/benchmark-float';

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
/**
 * A NON-ADMIN synthetic user. Admins are routed to `issueAdminCompanyCard` (company-funded, no
 * Stripe hold), which makes the lifecycle benchmarks' `stripeHold` assertions unreachable.
 */
const DEFAULT_BENCHMARK_USER_ID = BENCHMARK_PAYMENT_LIFECYCLE_USER_ID;
const DEFAULT_SANDBOX_CARDHOLDER_ID = 'cmrfpz6d1000bl804w1gggfto';
/**
 * Non-admin benchmark users are subject to the normal credit gate (`unlimited` is admin-only), so
 * a depleted fixture user would stall every agent at OUT_OF_CREDITS. Top the balance up to this
 * much headroom above recorded usage instead of deleting ledger rows.
 */
const BENCHMARK_CREDIT_HEADROOM_CENTS = 100_000;

async function seedAgentCardConnection(prisma: PrismaClient, userId: string): Promise<void> {
  const cardholderId =
    process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID?.trim() || DEFAULT_SANDBOX_CARDHOLDER_ID;
  const config = { orgManaged: true, cardholderId };
  await prisma.integration.upsert({
    where: { userId_name: { userId, name: 'agentcard' } },
    create: {
      userId,
      name: 'agentcard',
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config,
    },
    update: {
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config,
      lastUsedAt: new Date(),
    },
  });
  console.log(
    `Seeded AgentCard org cardholder fixture ${cardholderId} for benchmark user ${userId}`
  );
}

/**
 * Keep the fixture user solvent without destroying its ledger. `getUserUsage` computes
 * `remaining = credits - toolUsage`, so a synthetic user accumulates usage across runs and would
 * eventually be gated at OUT_OF_CREDITS. Add only the deficit, so repeated seeding is idempotent.
 */
async function ensureBenchmarkCredits(prisma: PrismaClient, userId: string): Promise<void> {
  const now = new Date();
  const [creditTotal, usageTotal] = await Promise.all([
    prisma.credit.aggregate({
      where: { userId, OR: [{ expirationDate: null }, { expirationDate: { gt: now } }] },
      _sum: { amountCents: true },
    }),
    prisma.toolUsage.aggregate({ where: { userId }, _sum: { totalCostCents: true } }),
  ]);
  const availableCents = creditTotal._sum.amountCents ?? 0;
  const usedCents = usageTotal._sum.totalCostCents ?? 0;
  const deficitCents = usedCents + BENCHMARK_CREDIT_HEADROOM_CENTS - availableCents;
  if (deficitCents <= 0) {
    console.log(
      `Benchmark credit balance already sufficient for ${userId} ` +
        `($${((availableCents - usedCents) / 100).toFixed(2)} remaining)`
    );
    return;
  }
  await prisma.credit.create({ data: { userId, amountCents: deficitCents, expirationDate: null } });
  console.log(
    `Topped up benchmark credits for ${userId} by $${(deficitCents / 100).toFixed(2)} ` +
      `(used $${(usedCents / 100).toFixed(2)})`
  );
}

/**
 * The lifecycle benchmarks assert a personal Stripe hold, which only the non-admin funding path
 * produces. Seeding an admin here would silently re-route every benchmark purchase to
 * `issueAdminCompanyCard` and make those assertions unsatisfiable, so fail loudly instead.
 */
function assertNonAdminBenchmarkUser(userId: string): void {
  if (!isAdminUser(userId)) return;
  throw new Error(
    `Refusing to seed the payment-lifecycle fixture for admin user ${userId}: admins mint ` +
      'company-funded cards with no Stripe hold, so the lifecycle benchmarks can never pass. ' +
      `Use the dedicated non-admin benchmark user (${BENCHMARK_PAYMENT_LIFECYCLE_USER_ID}).`
  );
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

/**
 * The benchmark organization and its cardholder are two halves of one wallet
 * fixture. Overriding only one (e.g. funding a custom org while the integration
 * keeps the default cardholder) prepares the wrong wallet and silently breaks
 * the lifecycle fixture. Require the pair to move together.
 */
function assertBenchmarkOrgCardholderPair(): void {
  const orgId = process.env.BENCHMARK_AGENTCARD_ORG_ID?.trim();
  const cardholderId = process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID?.trim();
  const orgSet = orgId !== undefined && orgId !== '';
  const cardholderSet = cardholderId !== undefined && cardholderId !== '';
  if (orgSet !== cardholderSet) {
    throw new Error(
      'BENCHMARK_AGENTCARD_ORG_ID and BENCHMARK_AGENTCARD_CARDHOLDER_ID must be set together ' +
        '(a custom organization with the default cardholder funds the wrong wallet).'
    );
  }
}

function requireStripeTestKey(): string {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key.trim()) {
    throw new Error('STRIPE_SECRET_KEY is required to seed benchmark payment billing');
  }
  if (!key.startsWith('sk_test_') && process.env.BENCHMARK_ALLOW_LIVE_STRIPE !== 'true') {
    throw new Error(
      'Refusing to seed benchmark payment billing with a non-test Stripe key. ' +
        'Use sk_test_* or set BENCHMARK_ALLOW_LIVE_STRIPE=true intentionally.'
    );
  }
  return key;
}

async function main(): Promise<void> {
  assertBenchmarkOrgCardholderPair();
  const userId =
    argValue('--user-id') ?? process.env.BENCHMARK_USER_ID ?? DEFAULT_BENCHMARK_USER_ID;
  assertNonAdminBenchmarkUser(userId);
  const stripe = new Stripe(requireStripeTestKey(), { apiVersion: STRIPE_API_VERSION });
  const prisma = new PrismaClient();

  try {
    // `offWaitlistAt` keeps the fixture user past the invite gate. Without it the benchmark's FE
    // link (`?agent-id=…`) renders the "You're On The Waitlist!" overlay on top of the run, which
    // makes every human verification of a benchmark agent look broken.
    const onboarded = {
      isAnonymous: false,
      name: 'Rose Labs Benchmark Payer',
      offWaitlistAt: new Date(),
      onboardingCompletedAt: new Date(),
    };
    await prisma.user.upsert({
      where: { userId },
      update: onboarded,
      create: { userId, ...onboarded },
    });
    await ensureBenchmarkCredits(prisma, userId);

    const customer = await stripe.customers.create({
      name: 'Rose Labs Benchmark User',
      email: `benchmark-payment-${Date.now()}@example.test`,
      metadata: {
        userId,
        fixture: 'agent-payment-test-shop',
      },
    });

    const paymentMethod = await stripe.paymentMethods.create({
      type: 'card',
      card: {
        token: 'tok_visa',
      },
      billing_details: {
        name: 'Rose Labs Benchmark User',
        email: `benchmark-payment-${Date.now()}@example.test`,
      },
    });

    await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethod.id },
    });

    await prisma.subscription.upsert({
      where: { userId },
      update: {
        subscriptionTier: 1,
        stripeCustomerId: customer.id,
        stripeSubscriptionId: `benchmark_${randomUUID()}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      create: {
        userId,
        subscriptionTier: 1,
        stripeCustomerId: customer.id,
        stripeSubscriptionId: `benchmark_${randomUUID()}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.purchaseSpend.deleteMany({
      where: {
        userId,
        merchant: 'Rose Labs Test Payment',
      },
    });

    await seedAgentCardConnection(prisma, userId);

    // The org identity now travels in the client-credential token itself
    // (AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET), so no explicit orgId is needed.
    const sandboxFloat = await ensureAgentCardSandboxFloat();
    console.log(
      `AgentCard sandbox pool ready at $${(sandboxFloat.availableCents / 100).toFixed(2)} available ` +
        `($${(sandboxFloat.balanceCents / 100).toFixed(2)} balance)`
    );

    console.log(`Seeded Stripe and AgentCard payment fixtures for benchmark user ${userId}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
