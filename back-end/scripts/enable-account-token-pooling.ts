/**
 * Turn ON the account-level compute-token pooling policy for one account and
 * backfill its already-synced credentials so the pool is non-empty immediately.
 *
 * Why this exists: `User.poolTokensByDefault` only takes effect on the NEXT
 * credential sync. An account that already has a `poolingEnabled=false`
 * claude_code / gpt_code row would keep an empty pool until the mac-app pushes
 * a rotated token — which is exactly the single point of failure that motivated
 * the account-level default (three concurrent benchmark agents fell through to
 * the paid OpenRouter waterfall because `fetchPoolToken` had nothing to rotate
 * to when the owner's own token hit its rate-limit window).
 *
 * Idempotent: re-running reports "already" for every row it does not change.
 * Rows carrying an explicit `poolingEnabledOverride=false` are left alone
 * unless --force-override is passed, because an explicit per-integration
 * choice outranks the account policy.
 *
 * Usage:
 *   DATABASE_URL=... DIRECT_URL=... \
 *   npx tsx back-end/scripts/enable-account-token-pooling.ts --user-id <userId> [--apply]
 *
 * Without --apply this is a dry run that prints the plan.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CREDENTIAL_INTEGRATION_NAMES = ['claude_code', 'gpt_code'];

function readFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const userId = readFlagValue('--user-id') ?? process.env.POOL_DEFAULT_USER_ID;
const apply = process.argv.includes('--apply');
const forceOverride = process.argv.includes('--force-override');

async function main() {
  if (userId === undefined || userId.trim() === '') {
    console.error('--user-id <userId> (or POOL_DEFAULT_USER_ID) is required');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { userId },
    select: { userId: true, name: true, phone: true, poolTokensByDefault: true },
  });
  if (!user) {
    console.error(`No User row with userId=${userId}`);
    process.exit(1);
  }

  const integrations = await prisma.integration.findMany({
    where: { userId, name: { in: CREDENTIAL_INTEGRATION_NAMES } },
    select: {
      id: true,
      name: true,
      status: true,
      poolingEnabled: true,
      poolingEnabledOverride: true,
    },
    orderBy: { name: 'asc' },
  });

  console.log(`User ${user.userId} (${user.name ?? 'unnamed'} / ${user.phone ?? 'no phone'})`);
  console.log(`  poolTokensByDefault: ${user.poolTokensByDefault} -> true`);
  console.log(`  credential integrations: ${integrations.length}`);

  const toEnable = integrations.filter((row) => {
    if (row.poolingEnabled) return false;
    return forceOverride || row.poolingEnabledOverride !== false;
  });
  for (const row of integrations) {
    const skipped = !row.poolingEnabled && !toEnable.includes(row);
    const action = row.poolingEnabled
      ? 'already pooled'
      : skipped
        ? 'SKIP (explicit poolingEnabledOverride=false; pass --force-override)'
        : 'pool -> true';
    console.log(`    ${row.name} id=${row.id.slice(0, 8)} status=${row.status}: ${action}`);
  }

  if (!apply) {
    console.log('\nDry run. Pass --apply to execute.');
    return;
  }

  await prisma.user.update({ where: { userId }, data: { poolTokensByDefault: true } });
  console.log('\nApplied: poolTokensByDefault=true');

  for (const row of toEnable) {
    await prisma.integration.update({
      where: { id: row.id },
      // Leave `poolingEnabledOverride` null: this row is inheriting the account
      // policy, not opting out of it, so a future explicit choice still wins.
      data: { poolingEnabled: true, rateLimitedUntil: null },
    });
    console.log(`Applied: ${row.name} ${row.id.slice(0, 8)} poolingEnabled=true`);
  }

  const pooled = await prisma.integration.count({
    where: { userId, name: { in: CREDENTIAL_INTEGRATION_NAMES }, poolingEnabled: true },
  });
  console.log(`Done. Pool-eligible credentials for this account: ${pooled}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
