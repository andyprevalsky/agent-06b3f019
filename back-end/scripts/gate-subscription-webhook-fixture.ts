/**
 * Supplement for gate-subscription-webhook-resume: after the depleted
 * purchase-subscription gate fixture runs, provision a real Stripe test
 * billing customer (tok_visa) and org-managed AgentCard so the simulated
 * checkout.session.completed webhook can activate a subscription that
 * actually supports purchase-card minting.
 */
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import {
  ensureBenchmarkOrgCardholder,
  resolveBenchmarkCardholderId,
  waitOutBenchmarkOrgBackpressure,
} from '../src/providers/agentcard/benchmark-float';
import { seedOrgManagedAgentCardForUser } from './gate-benchmark-fixture';

dotenv.config();

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
const GATE_USER_ID = '00000000-0000-4000-8000-000000000102';

async function createSandboxBillingCustomer(stripe: Stripe, userId: string): Promise<string> {
  const email = `gate-sub-webhook-${Date.now()}@example.test`;
  const customer = await stripe.customers.create({
    name: 'Gate Subscription Webhook Benchmark',
    email,
    metadata: { userId, fixture: 'gate-subscription-webhook-resume' },
  });
  const paymentMethod = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: 'tok_visa' },
    billing_details: { name: 'Gate Subscription Webhook Benchmark', email },
  });
  await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });
  return customer.id;
}

async function main(): Promise<void> {
  const userId = (process.env.BENCHMARK_USER_ID || GATE_USER_ID).trim();

  const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (secretKey === '' || secretKey.startsWith('sk_live_')) {
    throw new Error(
      'STRIPE_SECRET_KEY must be a test-mode key for gate-subscription-webhook fixture'
    );
  }

  const prisma = new PrismaClient();
  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });

  try {
    const stripeCustomerId = await createSandboxBillingCustomer(stripe, userId);
    const cardholderId = await waitOutBenchmarkOrgBackpressure(async () => {
      const resolvedId = await resolveBenchmarkCardholderId();
      await ensureBenchmarkOrgCardholder(resolvedId);
      return resolvedId;
    });
    await seedOrgManagedAgentCardForUser(userId, cardholderId, prisma);

    console.log(
      JSON.stringify({
        user_id: userId,
        stripe_customer_id: stripeCustomerId,
        agentcard_org_cardholder_id: cardholderId,
      })
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
