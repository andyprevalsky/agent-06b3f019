import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import {
  ensureAgentCardSandboxFloat,
  resolveBenchmarkCardholderId,
} from '../src/providers/agentcard/benchmark-float';
import { BENCHMARK_PAYMENT_LIFECYCLE_USER_ID } from '../src/domains/purchases/config';
import { isAdminUser } from '../src/utils/adminAccess';

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
// Keep payment settlement on the normal Stripe-backed path. The dedicated lifecycle identity is
// intentionally non-admin so benchmarks exercise Stripe hold, capture, and refund behavior.
const DEFAULT_BENCHMARK_USER_ID = BENCHMARK_PAYMENT_LIFECYCLE_USER_ID;
const BENCHMARK_CREDIT_HEADROOM_CENTS = 100_000;

async function seedAgentCardConnection(
  prisma: PrismaClient,
  userId: string,
  cardholderId: string
): Promise<void> {
  const configured = process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID?.trim();
  if (configured !== undefined && configured !== '' && configured !== cardholderId) {
    console.warn(
      `BENCHMARK_AGENTCARD_CARDHOLDER_ID=${configured} is not present in the sandbox org; ` +
        `seeding live cardholder ${cardholderId} instead`
    );
  }
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

/** Restrict destructive fixture replacement to the disposable lifecycle identity. */
function assertDedicatedBenchmarkUser(userId: string): void {
  if (userId === DEFAULT_BENCHMARK_USER_ID) return;
  throw new Error(
    `Refusing to seed payment fixtures for ${userId}; this command is restricted to the ` +
      `dedicated benchmark user ${DEFAULT_BENCHMARK_USER_ID}`
  );
}

/**
 * Keep the synthetic user solvent without deleting ledger history. The advisory lock serializes
 * concurrent setup processes; topping up only the deficit makes repeated runs idempotent.
 */
async function ensureBenchmarkCredits(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // Prisma cannot deserialize PostgreSQL's `void` return type, so materialize the lock call
      // and project a supported scalar instead of selecting pg_advisory_xact_lock directly.
      await tx.$queryRaw`
        WITH acquired AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(
            hashtext(${`benchmark-payment-credit:${userId}`})::bigint
          )
        )
        SELECT 1 AS locked FROM acquired
      `;
      const now = new Date();
      const [creditTotal, usageTotal] = await Promise.all([
        tx.credit.aggregate({
          where: { userId, OR: [{ expirationDate: null }, { expirationDate: { gt: now } }] },
          _sum: { amountCents: true },
        }),
        tx.toolUsage.aggregate({ where: { userId }, _sum: { totalCostCents: true } }),
      ]);
      const availableCents = creditTotal._sum.amountCents ?? 0;
      const usedCents = usageTotal._sum.totalCostCents ?? 0;
      const deficitCents = usedCents + BENCHMARK_CREDIT_HEADROOM_CENTS - availableCents;
      if (deficitCents > 0) {
        await tx.credit.create({
          data: { userId, amountCents: deficitCents, expirationDate: null },
        });
      }
    },
    { maxWait: 10_000, timeout: 10_000 }
  );
}

async function main(): Promise<void> {
  assertBenchmarkOrgCardholderPair();
  const userId =
    argValue('--user-id') ?? process.env.BENCHMARK_USER_ID ?? DEFAULT_BENCHMARK_USER_ID;
  assertDedicatedBenchmarkUser(userId);
  if (isAdminUser(userId)) {
    throw new Error(
      `AgentCard lifecycle fixture user ${userId} must be non-admin so Stripe hold semantics remain testable`
    );
  }
  const stripe = new Stripe(requireStripeTestKey(), { apiVersion: STRIPE_API_VERSION });
  const prisma = new PrismaClient();

  try {
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

    // Non-admin agents are subject to the normal Rose credit gate.
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

    // The org identity now travels in the client-credential token itself
    // (AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET), so no explicit orgId is needed.
    const sandboxFloat = await ensureAgentCardSandboxFloat();
    console.log(
      `AgentCard sandbox pool ready at $${(sandboxFloat.availableCents / 100).toFixed(2)} available ` +
        `($${(sandboxFloat.balanceCents / 100).toFixed(2)} balance)`
    );

    // Verify cardholder against list_cardholders so a stale BENCHMARK_* override cannot
    // seed Integration with an id the org MCP will reject as "Cardholder not found".
    const cardholderId = await resolveBenchmarkCardholderId();
    await seedAgentCardConnection(prisma, userId, cardholderId);

    console.log(
      `Seeded Stripe, Rose credit, and AgentCard payment fixtures for benchmark user ${userId}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
