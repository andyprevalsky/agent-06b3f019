#!/usr/bin/env tsx
/**
 * Monitor and verify cooperative Temporal generation cutover progress.
 *
 * Used by /deploy post-merge verification to report pointer flip, old-generation
 * drain, and final cutover health without force-migrating on the happy path.
 *
 * Usage:
 *   monitor-cooperative-cutover.ts --expected-hash <surfaceHash> [--old-queue <queue>]
 *   monitor-cooperative-cutover.ts --expected-hash <hash> --verify [--old-queue <queue>]
 *   monitor-cooperative-cutover.ts --expected-hash <hash> --json [--old-queue <queue>]
 *
 * Exit codes:
 *   0 — verify passed (or report-only success)
 *   1 — verify failed (pointer mismatch, old queue not drained, etc.)
 *   2 — usage / configuration error
 */
import { config } from 'dotenv';
import { readAgentQueuePointer } from '../src/providers/agentQueuePointer';
import { prisma } from '../src/providers/database';
import { getTemporalClient } from '../src/providers/temporal';

config();

const TERMINAL = ['COMPLETED', 'FAILED'] as const;

type CutoverPhase =
  | 'awaiting_pointer_flip'
  | 'draining_old_generation'
  | 'cooperative_drain_complete'
  | 'same_generation';

type CutoverReport = {
  phase: CutoverPhase;
  expectedSurfaceHash: string;
  expectedQueue: string;
  livePointer: {
    taskQueue: string | null;
    surfaceHash: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
  };
  pointerMatchesExpected: boolean;
  oldQueue: string | null;
  oldQueueOpenCount: number | null;
  verifyOk: boolean;
  messages: string[];
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function countOpenOnQueue(queue: string): Promise<number> {
  try {
    const client = await getTemporalClient();
    const query = `TaskQueue = "${queue}" AND ExecutionStatus = "Running"`;
    let count = 0;
    for await (const _execution of client.workflow.list({ query })) {
      count += 1;
    }
    return count;
  } catch {
    const dbCount = await prisma.agent.count({
      where: {
        deletedAt: null,
        temporalWorkflowId: { not: null },
        workflowTaskQueue: queue,
        status: { notIn: [...TERMINAL] },
      },
    });
    return dbCount;
  }
}

async function buildReport(expectedHash: string, oldQueue: string | null): Promise<CutoverReport> {
  const expectedQueue = `navi-agent-tasks@${expectedHash}`;
  const row = await readAgentQueuePointer();
  const livePointer = {
    taskQueue: row?.taskQueue ?? null,
    surfaceHash: row?.surfaceHash ?? null,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
  const pointerMatchesExpected =
    livePointer.surfaceHash === expectedHash && livePointer.taskQueue === expectedQueue;

  const messages: string[] = [];
  let phase: CutoverPhase;
  let oldQueueOpenCount: number | null = null;

  if (!oldQueue || oldQueue === expectedQueue) {
    phase = pointerMatchesExpected ? 'same_generation' : 'awaiting_pointer_flip';
    if (pointerMatchesExpected) {
      messages.push(`Live pointer on expected generation ${expectedHash} (rolling/same-hash deploy).`);
    } else {
      messages.push(
        `Waiting for pointer flip: live=${livePointer.surfaceHash ?? '<none>'} expected=${expectedHash}`
      );
    }
  } else if (!pointerMatchesExpected) {
    phase = 'awaiting_pointer_flip';
    messages.push(
      `Pointer not yet on new generation (live=${livePointer.surfaceHash ?? '<none>'}, expected=${expectedHash}).`
    );
  } else {
    oldQueueOpenCount = await countOpenOnQueue(oldQueue);
    if (oldQueueOpenCount === 0) {
      phase = 'cooperative_drain_complete';
      messages.push(`Cooperative drain complete: 0 open workflows on old queue ${oldQueue}.`);
    } else {
      phase = 'draining_old_generation';
      messages.push(
        `${oldQueueOpenCount} open workflow(s) still on old generation queue ${oldQueue} (cooperative handoff in progress).`
      );
    }
  }

  let verifyOk = pointerMatchesExpected;
  if (verifyOk && oldQueue && oldQueue !== expectedQueue) {
    oldQueueOpenCount ??= await countOpenOnQueue(oldQueue);
    verifyOk = oldQueueOpenCount === 0;
    if (!verifyOk) {
      messages.push(`VERIFY FAILED: old queue ${oldQueue} still has ${oldQueueOpenCount} open workflow(s).`);
    }
  }
  if (verifyOk && !pointerMatchesExpected) {
    verifyOk = false;
    messages.push('VERIFY FAILED: live pointer does not match expected generation.');
  }

  return {
    phase,
    expectedSurfaceHash: expectedHash,
    expectedQueue,
    livePointer,
    pointerMatchesExpected,
    oldQueue,
    oldQueueOpenCount,
    verifyOk,
    messages,
  };
}

function printHuman(report: CutoverReport): void {
  process.stdout.write(`Cooperative cutover phase: ${report.phase}\n`);
  process.stdout.write(
    `  live pointer: hash=${report.livePointer.surfaceHash ?? '<none>'} queue=${report.livePointer.taskQueue ?? '<none>'}\n`
  );
  process.stdout.write(
    `  expected:     hash=${report.expectedSurfaceHash} queue=${report.expectedQueue}\n`
  );
  if (report.oldQueue) {
    process.stdout.write(
      `  old queue:    ${report.oldQueue} open=${report.oldQueueOpenCount ?? '?'}\n`
    );
  }
  for (const message of report.messages) {
    process.stdout.write(`  → ${message}\n`);
  }
}

async function main(): Promise<void> {
  const expectedHash = argValue('--expected-hash');
  const oldQueue = argValue('--old-queue') ?? null;
  const verify = process.argv.includes('--verify');
  const asJson = process.argv.includes('--json');

  if (!expectedHash?.trim()) {
    process.stderr.write(
      'Usage: monitor-cooperative-cutover.ts --expected-hash <surfaceHash> [--old-queue <queue>] [--verify] [--json]\n'
    );
    process.exit(2);
  }

  const report = await buildReport(expectedHash.trim(), oldQueue?.trim() || null);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }

  await prisma.$disconnect();

  if (verify && !report.verifyOk) {
    process.exit(1);
  }
}

main().catch(async (err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
