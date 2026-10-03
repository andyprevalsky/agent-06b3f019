/** Rebuild the SQL grep projection from finalized encrypted R2 trace bundles. */

import 'dotenv/config';
import { listArchiveBundleIdsStrict } from '../src/providers/traceArchiveAudit';
import {
  ArchivedTraceNotFoundError,
  indexArchivedTraceFromR2,
} from '../src/providers/traceArchiveSearchIndex';
import { prisma } from '../src/providers/database';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const usage =
    'Usage: backfill-agent-trajectory-search.ts [--root-agent-id <id> | --user-id <id> | --all-users] [--scan-r2 with --user-id or --all-users] [--concurrency 1..32]';
  const rootArg = args.indexOf('--root-agent-id');
  const userArg = args.indexOf('--user-id');
  const concurrencyArg = args.indexOf('--concurrency');
  const allUsers = args.includes('--all-users');
  const scanR2 = args.includes('--scan-r2');
  const concurrency = concurrencyArg >= 0 ? Number(args[concurrencyArg + 1]) : 4;
  const scopeCount = Number(rootArg >= 0) + Number(userArg >= 0) + Number(allUsers);
  const badOperand = (index: number) =>
    index >= 0 && (!args[index + 1] || args[index + 1].startsWith('-'));
  const flags = ['--root-agent-id', '--user-id', '--all-users', '--scan-r2', '--concurrency'];
  if (
    scopeCount !== 1 ||
    badOperand(rootArg) ||
    badOperand(userArg) ||
    badOperand(concurrencyArg) ||
    flags.some((flag) => args.filter((arg) => arg === flag).length > 1) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    (scanR2 && rootArg >= 0) ||
    (rootArg >= 0 && !args[rootArg + 1]) ||
    (userArg >= 0 && !args[userArg + 1]) ||
    args.some(
      (arg) =>
        ![
          '--root-agent-id',
          '--user-id',
          '--all-users',
          '--scan-r2',
          '--concurrency',
          rootArg >= 0 ? args[rootArg + 1] : '',
          userArg >= 0 ? args[userArg + 1] : '',
          concurrencyArg >= 0 ? args[concurrencyArg + 1] : '',
        ].includes(arg)
    )
  ) {
    throw new Error(usage);
  }
  // PlannerMemory is the SQL catalog of finalized roots. Use it for routine
  // backfills; a full R2 bucket listing is an explicit orphan-repair pass.
  const roots =
    rootArg >= 0
      ? [args[rootArg + 1]]
      : scanR2
        ? await listArchiveBundleIdsStrict()
        : (
            await prisma.plannerMemory.findMany({
              where: { userId: userArg >= 0 ? args[userArg + 1] : { not: null } },
              select: { id: true },
              orderBy: { id: 'asc' },
            })
          ).map((row) => row.id);
  if (scanR2 && roots.length === 0) {
    throw new Error(
      'R2 scan returned no archive roots; refusing to report an empty backfill as complete'
    );
  }
  let cursor = 0;
  let indexed = 0;
  let skipped = 0;
  let rows = 0;
  let incompleteUnowned = 0;
  const expectedUserId = userArg >= 0 ? args[userArg + 1] : undefined;
  const failures: Array<{ root: string; error: string }> = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, roots.length) }, async () => {
      while (cursor < roots.length) {
        const root = roots[cursor++];
        try {
          const count = await indexArchivedTraceFromR2(root, expectedUserId);
          rows += count;
          if (count === 0) {
            skipped += 1;
          } else {
            indexed += 1;
            if (indexed % 100 === 0) {
              process.stderr.write(`Indexed ${indexed}/${roots.length} archive roots\n`);
            }
          }
        } catch (error) {
          // R2 can contain an interrupted root with only LLM artifacts and no
          // owner-bearing manifest or DB fixture. Only skip it when the SQL
          // catalog also has no owner in this backfill's scope. A finalized,
          // user-owned root with a missing manifest is a failed archive.
          if (
            scanR2 &&
            error instanceof ArchivedTraceNotFoundError &&
            error.message.endsWith('/manifest.json.gz.enc')
          ) {
            const catalogRoot = await prisma.plannerMemory.findUnique({
              where: { id: root },
              select: { userId: true },
            });
            if (expectedUserId && catalogRoot?.userId && catalogRoot.userId !== expectedUserId) {
              skipped += 1;
            } else if (!catalogRoot?.userId) {
              skipped += 1;
              incompleteUnowned += 1;
            } else {
              failures.push({ root, error: error.message });
            }
          } else {
            failures.push({ root, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    })
  );
  if (scanR2 && failures.length === 0 && indexed > 0) {
    await prisma.$executeRaw`ANALYZE "AgentTrajectorySearch"`;
  }
  process.stdout.write(
    JSON.stringify({ total: roots.length, indexed, skipped, incompleteUnowned, rows, failures }) +
      '\n'
  );
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
