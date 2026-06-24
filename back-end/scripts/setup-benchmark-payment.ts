import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
const DEFAULT_BENCHMARK_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
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
  const userId = argValue('--user-id') ?? process.env.BENCHMARK_USER_ID ?? DEFAULT_BENCHMARK_USER_ID;
  const stripe = new Stripe(requireStripeTestKey(), { apiVersion: STRIPE_API_VERSION });
  const prisma = new PrismaClient();

  try {
    await prisma.user.upsert({
      where: { userId },
      update: { isAnonymous: true },
      create: { userId, isAnonymous: true },
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

    console.log(`Seeded Stripe test billing fixture for benchmark user ${userId}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
