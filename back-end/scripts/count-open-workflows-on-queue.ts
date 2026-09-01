#!/usr/bin/env tsx
/**
 * Count open agent workflows still pinned to a generation task queue.
 *
 * Used by cooperative cutover to wait for continue_as_new handoff before the
 * 45-minute force-migrate SLO. Temporal visibility is authoritative (continue_as_new
 * moves the execution to the new queue immediately). The Agent.workflowTaskQueue
 * column is used as a fallback when visibility is unavailable.
 *
 * Usage:
 *   count-open-workflows-on-queue.ts --queue navi-agent-tasks@abc123
 *
 * Prints a single integer to stdout.
 */
import { config } from 'dotenv';
import { prisma } from '../src/providers/database';
import { getTemporalClient } from '../src/providers/temporal';

config();

const TERMINAL = ['COMPLETED', 'FAILED'] as const;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function countFromTemporal(queue: string): Promise<number | null> {
  try {
    const client = await getTemporalClient();
    const query = `TaskQueue = "${queue}" AND ExecutionStatus = "Running"`;
    let count = 0;
    for await (const _execution of client.workflow.list({ query })) {
      count += 1;
    }
    return count;
  } catch (err) {
    process.stderr.write(
      `temporal visibility count failed (falling back to DB): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return null;
  }
}

async function countFromDatabase(queue: string): Promise<number> {
  const dbCount = await prisma.agent.count({
    where: {
      deletedAt: null,
      temporalWorkflowId: { not: null },
      workflowTaskQueue: queue,
      status: { notIn: [...TERMINAL] },
    },
  });

  // Rows without workflowTaskQueue still need Temporal visibility (legacy).
  const legacyOpen = await prisma.agent.count({
    where: {
      deletedAt: null,
      temporalWorkflowId: { not: null },
      workflowTaskQueue: null,
      status: { notIn: [...TERMINAL] },
    },
  });

  let temporalLegacy = 0;
  if (legacyOpen > 0) {
    const legacyCount = await countFromTemporal(queue);
    if (legacyCount !== null) {
      temporalLegacy = legacyCount;
    }
  }

  return dbCount + temporalLegacy;
}

async function main(): Promise<void> {
  const queue = argValue('--queue');
  if (!queue) {
    process.stderr.write('Usage: count-open-workflows-on-queue.ts --queue <task-queue>\n');
    process.exit(2);
  }

  const temporalCount = await countFromTemporal(queue);
  const total = temporalCount ?? (await countFromDatabase(queue));

  process.stdout.write(`${total}\n`);
  await prisma.$disconnect();
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
