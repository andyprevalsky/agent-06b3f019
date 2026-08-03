import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { ensureAgentCardSandboxFloat } from '../src/providers/agentcard/benchmark-float';
import { isAdminUser } from '../src/utils/adminAccess';

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
// Keep the Stripe-backed lifecycle fixture on a non-admin identity. Real admin users intentionally
// bypass Stripe and receive company-funded cards, while these benchmarks assert the ordinary
// authorize/capture/refund lifecycle.
const DEFAULT_BENCHMARK_USER_ID = '00000000-0000-4000-8000-000000000106';
const BENCHMARK_CREDIT_CENTS = 100_000;
const DEFAULT_SANDBOX_CARDHOLDER_ID = 'cmrfpz6d1000bl804w1gggfto';

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
  if (isAdminUser(userId)) {
    throw new Error(
      `AgentCard lifecycle fixture user ${userId} must be non-admin so Stripe hold semantics remain testable`
    );
  }
  const stripe = new Stripe(requireStripeTestKey(), { apiVersion: STRIPE_API_VERSION });
  const prisma = new PrismaClient();

  try {
    await prisma.user.upsert({
      where: { userId },
      update: { isAnonymous: true },
      create: { userId, isAnonymous: true },
    });

    // Non-admin agents are subject to the normal Rose credit gate. Reset only the disposable
    // fixture's grants so interrupted benchmark agents can remain available for diagnostics while
    // every new run starts with a deterministic positive balance.
    await prisma.credit.deleteMany({ where: { userId } });
    await prisma.credit.create({
      data: {
        userId,
        amountCents: BENCHMARK_CREDIT_CENTS,
        expirationDate: null,
      },
    });

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
