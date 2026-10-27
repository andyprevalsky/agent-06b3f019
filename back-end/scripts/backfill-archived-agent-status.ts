/**
 * Settle archived agents still marked STARTING_UP/ACTIVE/PAUSED (audit Q7).
 *
 * Dry run (default) prints the pending count and target host; --execute writes
 * FAILED/"Archived by user" in 1000-row transactions with lock_timeout 2s and
 * statement_timeout 15s. Safe to re-run: a second run finds 0 pending.
 *
 *   cd back-end && npx tsx scripts/backfill-archived-agent-status.ts
 *   cd back-end && npx tsx scripts/backfill-archived-agent-status.ts --execute
 */
import 'dotenv/config';

import { prisma } from '../src/providers/database';
import { backfillArchivedAgentStatus } from '../src/providers/archivedAgentStatusBackfill';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const target = new URL(process.env.DATABASE_URL ?? 'postgresql://unset').hostname;
  process.stdout.write(`target host: ${target}; mode: ${execute ? 'EXECUTE' : 'dry run'}\n`);
  const result = await backfillArchivedAgentStatus({ execute });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
