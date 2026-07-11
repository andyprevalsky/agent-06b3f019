import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const USER_ID = process.env.BENCHMARK_USER_ID || '00000000-0000-4000-8000-000000000101';

type Manifest = {
  fixture_mode: 'synthetic';
  user_id: string;
  credit_cents: number;
  used_cents: number;
  remaining_cents: number;
  subscription: null;
};

async function cleanup(): Promise<void> {
  await prisma.agentAttentionRequest.deleteMany({ where: { userId: USER_ID } });
  await prisma.toolUsage.deleteMany({ where: { userId: USER_ID } });
  await prisma.subscription.deleteMany({ where: { userId: USER_ID } });
  await prisma.credit.deleteMany({ where: { userId: USER_ID } });
}

async function apply(): Promise<Manifest> {
  await prisma.user.upsert({
    where: { userId: USER_ID },
    create: {
      userId: USER_ID,
      isAnonymous: false,
      name: 'Free Credit Gate Benchmark',
    },
    update: {
      isAnonymous: false,
      name: 'Free Credit Gate Benchmark',
    },
  });

  await cleanup();

  await prisma.credit.create({
    data: {
      userId: USER_ID,
      amountCents: 1,
      expirationDate: null,
    },
  });

  await prisma.toolUsage.create({
    data: {
      userId: USER_ID,
      toolName: 'benchmark_fixture_usage',
      totalCostCents: 1,
      usageItems: [
        {
          provider: 'benchmark',
          model: 'fixture',
          total_cost_cents: 1,
          reason: 'Exhaust the one-cent free-credit fixture.',
        },
      ],
    },
  });

  return {
    fixture_mode: 'synthetic',
    user_id: USER_ID,
    credit_cents: 1,
    used_cents: 1,
    remaining_cents: 0,
    subscription: null,
  };
}

async function main(): Promise<void> {
  const action = process.argv[2] || 'apply';
  if (action === 'apply') {
    console.log(JSON.stringify(await apply()));
  } else if (action === 'cleanup') {
    await cleanup();
    console.log(JSON.stringify({ cleaned: true, user_id: USER_ID }));
  } else {
    throw new Error(`Unknown action "${action}". Expected apply or cleanup.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
