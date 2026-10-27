/** Rebuild the SQL grep projection from finalized encrypted R2 trace bundles. */

import 'dotenv/config';
import { appendFileSync } from 'node:fs';
import { listArchiveBundleIdsStrict } from '../src/providers/traceArchiveAudit';
import {
  ArchivedTraceNotFoundError,
  backfillLiveMessageSearchBatch,
  indexArchivedTraceFromR2,
  normalizeTrajectoryGoalBatch,
} from '../src/providers/traceArchiveSearchIndex';
import { prisma } from '../src/providers/database';

/**
 * Index live SQL messages written before the projection triggers existed, in
 * id-ordered batches so no statement approaches the pooler's statement timeout.
 * Idempotent and resumable: rerun with `--after <last cursor>` after an abort.
 */
async function backfillLiveMessages(args: string[]): Promise<void> {
  const usage =
    'Usage: backfill-agent-trajectory-search.ts --live-messages [--batch-size 1..10000] [--after <message id>]';
  const sizeArg = args.indexOf('--batch-size');
  const afterArg = args.indexOf('--after');
  const batchSize = sizeArg >= 0 ? Number(args[sizeArg + 1]) : 2000;
  const operands = new Set([sizeArg + 1, afterArg + 1].filter((index) => index > 0));
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 10_000 ||
    (afterArg >= 0 && (!args[afterArg + 1] || args[afterArg + 1].startsWith('-'))) ||
    args.some(
      (arg, index) => !operands.has(index) && arg !== '--batch-size' && arg !== '--after'
    ) ||
    args.filter((arg) => arg === '--batch-size' || arg === '--after').length !==
      Number(sizeArg >= 0) + Number(afterArg >= 0)
  ) {
    throw new Error(usage);
  }
  let afterId: string | null = afterArg >= 0 ? args[afterArg + 1] : null;
  let scanned = 0;
  let inserted = 0;
  let batches = 0;
  for (;;) {
    const batch = await backfillLiveMessageSearchBatch(afterId, batchSize);
    if (batch.scanned === 0) break;
    afterId = batch.lastMessageId;
    scanned += batch.scanned;
    inserted += batch.inserted;
    batches += 1;
    if (batches % 50 === 0) {
      process.stderr.write(
        `Scanned ${scanned} messages (${inserted} indexed); cursor ${afterId}\n`
      );
    }
  }
  await prisma.$executeRaw`ANALYZE "AgentTrajectorySearch"`;
  process.stdout.write(
    JSON.stringify({ mode: 'live-messages', scanned, inserted, batches, cursor: afterId }) + '\n'
  );
}

/**
 * Move legacy per-row goal/title copies onto AgentTrajectoryAgent in
 * primary-key-ordered batches (no statement scans the whole table).
 * Idempotent and resumable with `--after <last cursor>`. `--dry-run` counts
 * the same work read-only. `--receipt <file>` appends one JSON line per batch
 * with its cursor range, counts and the exact cleared rows, so every cleared
 * copy is recoverable from AgentTrajectoryAgent plus the receipt.
 */
async function normalizeAgentGoals(args: string[]): Promise<void> {
  const usage =
    'Usage: backfill-agent-trajectory-search.ts --agent-goals [--batch-size 1..5000] [--after <message id>] [--dry-run] [--receipt <file>] [--pause-ms 0..10000]';
  const valueFlags = ['--batch-size', '--after', '--receipt', '--pause-ms'];
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const operand = args[index + 1];
    if (!operand || operand.startsWith('-')) throw new Error(usage);
    return operand;
  };
  const operands = new Set(
    valueFlags
      .map((flag) => args.indexOf(flag))
      .filter((i) => i >= 0)
      .map((i) => i + 1)
  );
  if (
    args.some(
      (arg, index) => !operands.has(index) && !valueFlags.includes(arg) && arg !== '--dry-run'
    )
  ) {
    throw new Error(usage);
  }
  const batchSize = Number(value('--batch-size') ?? 1000);
  const pauseMs = Number(value('--pause-ms') ?? 0);
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 5_000 ||
    !Number.isInteger(pauseMs) ||
    pauseMs < 0 ||
    pauseMs > 10_000
  ) {
    throw new Error(usage);
  }
  const dryRun = args.includes('--dry-run');
  const receipt = value('--receipt');
  // Fail before any batch commits if the receipt cannot be written.
  if (receipt) appendFileSync(receipt, '', { mode: 0o600 });
  let afterId: string | null = value('--after') ?? null;
  let scanned = 0;
  let inserted = 0;
  let cleared = 0;
  const recorded = new Set<string>();
  for (let batches = 1; ; batches += 1) {
    const from = afterId;
    const batch = await normalizeTrajectoryGoalBatch(afterId, batchSize, { dryRun });
    if (batch.scanned === 0) break;
    afterId = batch.lastMessageId;
    scanned += batch.scanned;
    inserted += batch.inserted;
    cleared += batch.cleared;
    if (receipt) {
      appendFileSync(
        receipt,
        `${JSON.stringify({
          at: new Date().toISOString(),
          dryRun,
          after: from,
          through: batch.lastMessageId,
          scanned: batch.scanned,
          inserted: batch.inserted,
          cleared: batch.cleared,
          // Each cleared copy equalled its agent row; record that value once per
          // agent so the receipt alone restores every copy.
          agents: batch.clearedRows
            .filter((row) => !recorded.has(row.agentId) && recorded.add(row.agentId))
            .map(({ agentId, agentGoal, agentTitle }) => ({ agentId, agentGoal, agentTitle })),
          clearedRows: batch.clearedRows.map(({ messageId, agentId }) => ({ messageId, agentId })),
        })}\n`,
        { mode: 0o600 }
      );
    }
    if (batches % 50 === 0) {
      process.stderr.write(
        `Scanned ${scanned} rows (${inserted} agents, ${cleared} cleared${dryRun ? ', dry run' : ''}); cursor ${afterId}\n`
      );
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  process.stdout.write(
    `${JSON.stringify({ mode: 'agent-goals', dryRun, scanned, inserted, cleared, cursor: afterId })}\n`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--live-messages') {
    await backfillLiveMessages(args.slice(1));
    return;
  }
  if (args[0] === '--agent-goals') {
    await normalizeAgentGoals(args.slice(1));
    return;
  }
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
