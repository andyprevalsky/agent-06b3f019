import { PrismaClient, type Prisma } from '@prisma/client';
import dotenv from 'dotenv';
import { syncPlaidItemTransactions } from '../src/domains/integrations/service.plaidTransactions';
import { findActivePlaidItemsWithAccountsForUser } from '../src/domains/integrations/repo.plaid';

dotenv.config();

const prisma = new PrismaClient();
const USER_ID = process.env.BENCHMARK_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const FIXTURE_ITEM_PREFIX = 'benchmark-plaid-transactions';

type Manifest = {
  fixture_mode: 'synthetic' | 'real';
  user_id: string;
  transaction_count: number;
  monthly_spend_sep_2023_usd: string;
  doordash_orders_2025: number;
  dead_subscription_candidates: string[];
  connected_institutions: string[];
};

async function assertTransactionsTableExists(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'PlaidTransaction'
    ) AS exists
  `;
  if (rows[0]?.exists !== true) {
    throw new Error(
      'PlaidTransaction table does not exist. Apply the Prisma migration before validating Plaid transactions.'
    );
  }
}

async function cleanupSynthetic(): Promise<void> {
  const items = await prisma.plaidItem.findMany({
    where: { userId: USER_ID, plaidItemId: { startsWith: FIXTURE_ITEM_PREFIX } },
    select: { id: true },
  });
  const itemIds = items.map((item) => item.id);
  if (itemIds.length === 0) return;
  await prisma.plaidTransaction.deleteMany({ where: { userId: USER_ID, plaidItemId: { in: itemIds } } });
  await prisma.plaidAccount.deleteMany({ where: { userId: USER_ID, plaidItemId: { in: itemIds } } });
  await prisma.plaidItem.deleteMany({ where: { userId: USER_ID, id: { in: itemIds } } });
}

async function integrationId(): Promise<string> {
  await prisma.user.upsert({
    where: { userId: USER_ID },
    create: { userId: USER_ID, isAnonymous: false },
    update: {},
  });
  const integration = await prisma.integration.upsert({
    where: { userId_name: { userId: USER_ID, name: 'plaid' } },
    create: {
      userId: USER_ID,
      type: 'DATA_SOURCE',
      name: 'plaid',
      status: 'CONNECTED',
      isActive: true,
    },
    update: {
      status: 'CONNECTED',
      isActive: true,
    },
  });
  return integration.id;
}

async function addTransaction(data: {
  itemId: string;
  accountId: string;
  externalAccountId: string;
  plaidTransactionId: string;
  date: string;
  name: string;
  merchantName?: string | null;
  amount: string;
  category: string[];
  pending?: boolean;
  paymentChannel?: string;
}): Promise<void> {
  const amount = Number(data.amount);
  await prisma.plaidTransaction.create({
    data: {
      userId: USER_ID,
      plaidItemId: data.itemId,
      plaidAccountId: data.accountId,
      plaidTransactionId: data.plaidTransactionId,
      plaidAccountExternalId: data.externalAccountId,
      date: new Date(`${data.date}T00:00:00.000Z`),
      name: data.name,
      merchantName: data.merchantName ?? null,
      amount: data.amount,
      absoluteAmount: Math.abs(amount).toFixed(2),
      direction: amount >= 0 ? 'OUTFLOW' : 'INFLOW',
      isoCurrencyCode: 'USD',
      category: data.category,
      paymentChannel: data.paymentChannel ?? 'online',
      pending: data.pending ?? false,
    },
  });
}

async function applySynthetic(): Promise<Manifest> {
  await cleanupSynthetic();
  const plaidIntegrationId = await integrationId();
  const item = await prisma.plaidItem.create({
    data: {
      userId: USER_ID,
      integrationId: plaidIntegrationId,
      plaidItemId: `${FIXTURE_ITEM_PREFIX}-item`,
      plaidInstitutionId: 'benchmark-institution',
      institutionName: 'Benchmark Credit Union',
      encryptedAccessToken: 'REDACTED_AFTER_DISCONNECT',
      status: 'ACTIVE',
      products: ['transactions'],
      cursor: 'benchmark-cursor',
      lastSyncAt: new Date(),
    },
  });
  const checking = await prisma.plaidAccount.create({
    data: {
      userId: USER_ID,
      plaidItemId: item.id,
      plaidAccountId: `${FIXTURE_ITEM_PREFIX}-checking`,
      name: 'Benchmark Checking',
      mask: '4242',
      type: 'depository',
      subtype: 'checking',
    },
  });
  const card = await prisma.plaidAccount.create({
    data: {
      userId: USER_ID,
      plaidItemId: item.id,
      plaidAccountId: `${FIXTURE_ITEM_PREFIX}-card`,
      name: 'Benchmark Card',
      mask: '1881',
      type: 'credit',
      subtype: 'credit card',
    },
  });

  const sepSpend: Array<[string, string, string]> = [
    ['2023-09-01', 'September Rent', '1800.00'],
    ['2023-09-03', 'Whole Foods Market', '148.32'],
    ['2023-09-08', 'Shell Fuel', '64.18'],
    ['2023-09-12', 'Benchmark Gym Membership', '79.00'],
    ['2023-09-19', 'Tartine Bakery', '22.40'],
    ['2023-09-25', 'PG&E Utility', '70.52'],
  ];
  for (const [date, name, amount] of sepSpend) {
    await addTransaction({
      itemId: item.id,
      accountId: checking.id,
      externalAccountId: checking.plaidAccountId,
      plaidTransactionId: `${FIXTURE_ITEM_PREFIX}-${date}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      date,
      name,
      merchantName: name,
      amount,
      category: ['Benchmark', 'Monthly Spend'],
    });
  }
  await addTransaction({
    itemId: item.id,
    accountId: checking.id,
    externalAccountId: checking.plaidAccountId,
    plaidTransactionId: `${FIXTURE_ITEM_PREFIX}-sep-payroll`,
    date: '2023-09-15',
    name: 'Benchmark Payroll Deposit',
    merchantName: 'Benchmark Payroll',
    amount: '-5000.00',
    category: ['Payroll'],
  });

  for (let i = 1; i <= 7; i += 1) {
    await addTransaction({
      itemId: item.id,
      accountId: card.id,
      externalAccountId: card.plaidAccountId,
      plaidTransactionId: `${FIXTURE_ITEM_PREFIX}-doordash-2025-${i}`,
      date: `2025-${String(i).padStart(2, '0')}-10`,
      name: `DoorDash Order ${i}`,
      merchantName: 'DoorDash',
      amount: (18 + i).toFixed(2),
      category: ['Food and Drink', 'Delivery'],
    });
  }

  for (const merchant of ['StreamNest Premium', 'MeditatePro Annual', 'CloudBox Storage']) {
    await addTransaction({
      itemId: item.id,
      accountId: card.id,
      externalAccountId: card.plaidAccountId,
      plaidTransactionId: `${FIXTURE_ITEM_PREFIX}-dead-sub-${merchant.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      date: merchant.includes('Annual') ? '2025-02-01' : '2025-05-01',
      name: `${merchant} subscription charge`,
      merchantName: merchant,
      amount: merchant.includes('Annual') ? '119.99' : '14.99',
      category: ['Subscription', 'Likely unused'],
    });
  }
  await addTransaction({
    itemId: item.id,
    accountId: card.id,
    externalAccountId: card.plaidAccountId,
    plaidTransactionId: `${FIXTURE_ITEM_PREFIX}-active-sub`,
    date: '2025-06-01',
    name: 'GitHub subscription charge',
    merchantName: 'GitHub',
    amount: '10.00',
    category: ['Subscription', 'Active developer tool'],
  });

  return summarize('synthetic');
}

function decimalToNumber(value: Prisma.Decimal | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value.toString());
}

async function summarize(mode: Manifest['fixture_mode']): Promise<Manifest> {
  const [sepRows, doordashCount, txCount, institutionRows, deadRows] = await Promise.all([
    prisma.plaidTransaction.aggregate({
      where: {
        userId: USER_ID,
        removedAt: null,
        pending: false,
        direction: 'OUTFLOW',
        isoCurrencyCode: 'USD',
        date: { gte: new Date('2023-09-01T00:00:00.000Z'), lt: new Date('2023-10-01T00:00:00.000Z') },
      },
      _sum: { absoluteAmount: true },
    }),
    prisma.plaidTransaction.count({
      where: {
        userId: USER_ID,
        removedAt: null,
        pending: false,
        date: { gte: new Date('2025-01-01T00:00:00.000Z'), lt: new Date('2026-01-01T00:00:00.000Z') },
        OR: [
          { name: { contains: 'doordash', mode: 'insensitive' } },
          { merchantName: { contains: 'doordash', mode: 'insensitive' } },
        ],
      },
    }),
    prisma.plaidTransaction.count({ where: { userId: USER_ID, removedAt: null } }),
    prisma.plaidItem.findMany({
      where: { userId: USER_ID, status: { not: 'DISCONNECTED' } },
      distinct: ['institutionName'],
      select: { institutionName: true },
    }),
    prisma.plaidTransaction.findMany({
      where: {
        userId: USER_ID,
        removedAt: null,
        pending: false,
        OR: [
          { category: { hasSome: ['Subscription', 'Likely unused'] } },
          { name: { contains: 'subscription', mode: 'insensitive' } },
        ],
        NOT: [{ merchantName: { equals: 'GitHub', mode: 'insensitive' } }],
      },
      select: { merchantName: true, name: true },
      distinct: ['merchantName'],
      take: 10,
    }),
  ]);

  return {
    fixture_mode: mode,
    user_id: USER_ID,
    transaction_count: txCount,
    monthly_spend_sep_2023_usd: decimalToNumber(sepRows._sum.absoluteAmount).toFixed(2),
    doordash_orders_2025: doordashCount,
    dead_subscription_candidates: deadRows.map((row) => row.merchantName ?? row.name).filter(Boolean),
    connected_institutions: institutionRows
      .map((row) => row.institutionName)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  };
}

async function syncReal(): Promise<Manifest> {
  const items = await findActivePlaidItemsWithAccountsForUser(USER_ID);
  const syncable = items.filter((item) => item.encryptedAccessToken !== 'REDACTED_AFTER_DISCONNECT');
  if (syncable.length === 0) {
    throw new Error(`No active Plaid Items found for user ${USER_ID}; connect Plaid before running sync-real.`);
  }
  for (const item of syncable) {
    await syncPlaidItemTransactions(item.id);
  }
  return summarize('real');
}

async function inferSummaryMode(): Promise<Manifest['fixture_mode']> {
  const syntheticItem = await prisma.plaidItem.findFirst({
    where: { userId: USER_ID, plaidItemId: { startsWith: FIXTURE_ITEM_PREFIX } },
    select: { id: true },
  });
  return syntheticItem ? 'synthetic' : 'real';
}

async function main(): Promise<void> {
  await assertTransactionsTableExists();
  const action = process.argv[2] || 'summary';
  let manifest: Manifest | Record<string, never>;
  if (action === 'apply') manifest = await applySynthetic();
  else if (action === 'cleanup') {
    await cleanupSynthetic();
    manifest = {};
  } else if (action === 'sync-real') manifest = await syncReal();
  else if (action === 'summary') manifest = await summarize(await inferSummaryMode());
  else throw new Error(`Unknown action: ${action}`);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
