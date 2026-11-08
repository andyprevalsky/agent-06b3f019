/** Seed only the org AgentCard cardholder; subscription and payment method come from Checkout. */
import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import {
  ensureBenchmarkOrgCardholder,
  resolveBenchmarkCardholderId,
  waitOutBenchmarkOrgBackpressure,
} from '../src/providers/agentcard/benchmark-float';

dotenv.config();

async function main(): Promise<void> {
  const userId = (process.env.BENCHMARK_USER_ID || '').trim();
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  if (!userId || stripeKey !== stripeKey.trim() || !stripeKey.startsWith('sk_test_')) {
    throw new Error('New-user payment fixture requires BENCHMARK_USER_ID and Stripe test mode');
  }
  const prisma = new PrismaClient();
  try {
    const subscription = await prisma.subscription.findUnique({ where: { userId } });
    if (subscription) {
      throw new Error('New-user payment fixture must begin without a subscription');
    }
    const cardholderId = await waitOutBenchmarkOrgBackpressure(async () => {
      const resolvedId = await resolveBenchmarkCardholderId();
      await ensureBenchmarkOrgCardholder(resolvedId);
      return resolvedId;
    });
    await prisma.integration.upsert({
      where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
      create: {
        userId,
        name: 'agentcard',
        type: IntegrationType.TOOL_SETUP,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        config: { orgManaged: true, cardholderId },
      },
      update: {
        type: IntegrationType.TOOL_SETUP,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        config: { orgManaged: true, cardholderId },
      },
    });
    console.log(
      JSON.stringify({
        user_id: userId,
        subscription: null,
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
