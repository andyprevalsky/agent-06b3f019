import { PrismaClient, IntegrationStatus, IntegrationType } from '@prisma/client';
import dotenv from 'dotenv';
import { basename } from 'node:path';
import {
  ensureBenchmarkOrgCardholder,
  resolveBenchmarkCardholderId,
  waitOutBenchmarkOrgBackpressure,
} from '../src/providers/agentcard/benchmark-float';

dotenv.config();

const prisma = new PrismaClient();

const MODE = process.env.BENCHMARK_GATE_FIXTURE_MODE || process.argv[3] || 'source-connect';
const USER_IDS: Record<string, string> = {
  'purchase-subscription': '00000000-0000-4000-8000-000000000102',
  'purchase-kyc': '00000000-0000-4000-8000-000000000103',
  'source-connect': '00000000-0000-4000-8000-000000000104',
};

/**
 * Must equal `ADMIN_SUBSCRIPTION_BYPASS_USER_ID` in agents/benchmarks/run_benchmark.py and
 * `ADMIN_BYPASS_USER_ID` in agents/benchmarks/local.py. The admin-bypass gate runs as this user
 * under `purchase-subscription` mode (via BENCHMARK_USER_ID override).
 */
export const ADMIN_SUBSCRIPTION_BYPASS_USER_ID = '00000000-0000-4000-8000-000000000105'; // pragma: allowlist secret

type FixtureMode = 'purchase-subscription' | 'purchase-kyc' | 'source-connect';

function fixtureMode(): FixtureMode {
  if (MODE === 'purchase-subscription' || MODE === 'purchase-kyc' || MODE === 'source-connect') {
    return MODE;
  }
  throw new Error(`Unknown gate benchmark fixture mode "${MODE}"`);
}

function benchmarkUserId(mode: FixtureMode): string {
  return process.env.BENCHMARK_USER_ID || USER_IDS[mode];
}

async function cleanup(): Promise<void> {
  const mode = fixtureMode();
  const userId = benchmarkUserId(mode);
  await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
  await prisma.purchaseSpend.deleteMany({ where: { userId } });
  await prisma.toolUsage.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
  await prisma.subscription.deleteMany({ where: { userId } });
  await prisma.credit.deleteMany({ where: { userId } });
}

async function ensureUser(mode: FixtureMode, userId: string): Promise<void> {
  await prisma.user.upsert({
    where: { userId },
    create: {
      userId,
      isAnonymous: false,
      name: `Gate Benchmark ${mode}`,
    },
    update: {
      isAnonymous: false,
      name: `Gate Benchmark ${mode}`,
    },
  });
}

/**
 * Admin company-funded mints (`issueAdminCompanyCard` → `fundsSource: company_flow`) require an
 * org-managed AgentCard cardholder on the Integration row. The depleted purchase-subscription
 * fixture deletes all integrations, so without this re-seed the admin-bypass gate raises
 * `agentcard_user_cardholder_onboarding_required` instead of minting.
 */
export async function seedOrgManagedAgentCardForUser(
  userId: string,
  cardholderId: string,
  client: PrismaClient = prisma
): Promise<void> {
  const config = { orgManaged: true, cardholderId };
  await client.integration.upsert({
    where: { userId_name_accountId: { userId, name: 'agentcard', accountId: '' } },
    create: {
      userId,
      name: 'agentcard',
      accountId: '',
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
}

async function apply(): Promise<Record<string, unknown>> {
  const mode = fixtureMode();
  const userId = benchmarkUserId(mode);
  await ensureUser(mode, userId);
  await cleanup();

  await prisma.credit.create({
    data: {
      userId,
      amountCents: 10_000,
      expirationDate: null,
    },
  });

  if (mode === 'purchase-kyc') {
    await prisma.subscription.create({
      data: {
        userId,
        subscriptionTier: 20,
        stripeSubscriptionId: `sub_gate_kyc_${userId}`,
        stripeCustomerId: `cus_gate_kyc_${userId}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }

  if (mode === 'source-connect') {
    await prisma.integration.create({
      data: {
        userId,
        type: IntegrationType.DATA_SOURCE,
        name: 'gmail',
        status: IntegrationStatus.NOT_CONNECTED,
        isActive: false,
      },
    });
  }

  let agentcardOrgCardholderId: string | null = null;
  if (userId === ADMIN_SUBSCRIPTION_BYPASS_USER_ID) {
    // Prefer andy@roselabs.ai (live KYC-verified) or agentcard-benchmark@ (sandbox KYC).
    agentcardOrgCardholderId = await waitOutBenchmarkOrgBackpressure(async () => {
      const resolvedId = await resolveBenchmarkCardholderId();
      await ensureBenchmarkOrgCardholder(resolvedId);
      return resolvedId;
    });
    await seedOrgManagedAgentCardForUser(userId, agentcardOrgCardholderId);
  }

  return {
    fixture_mode: mode,
    user_id: userId,
    credit_cents: 10_000,
    subscription: mode === 'purchase-kyc' ? 'active_benchmark_subscription' : null,
    gmail_connected: false,
    agentcard_org_cardholder_id: agentcardOrgCardholderId,
  };
}

async function main(): Promise<void> {
  const action = process.argv[2] || 'apply';
  if (action === 'apply') {
    console.log(JSON.stringify(await apply()));
  } else if (action === 'cleanup') {
    await cleanup();
    const mode = fixtureMode();
    console.log(
      JSON.stringify({ cleaned: true, fixture_mode: mode, user_id: benchmarkUserId(mode) })
    );
  } else {
    throw new Error(`Unknown action "${action}". Expected apply or cleanup.`);
  }
}

if (basename(process.argv[1] || '') === 'gate-benchmark-fixture.ts') {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
