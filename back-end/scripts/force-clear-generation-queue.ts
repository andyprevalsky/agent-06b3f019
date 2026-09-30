#!/usr/bin/env tsx
/**
 * Break-glass after cooperative cutover's 45-minute drain SLO.
 *
 * Workflows still on the superseded generation queue cannot continue_as_new
 * (typically parked on user approval or another in-tool wait with an in-flight
 * activity). Replace those agents onto the live generation. Do not mark them
 * FAILED — that is how an approval-blocked browser purchase died in prod
 * (agent 3eb6da5a-280a-4456-a410-6b1799b06349).
 *
 * Usage:
 *   force-clear-generation-queue.ts --queue navi-agent-tasks@<oldHash> --execute
 */
import { config } from 'dotenv';
import { prisma } from '../src/providers/database';
import { getTemporalClient } from '../src/providers/temporal';
import { clearSupersededGenerationWorkflow } from '../src/providers/generationQueueCutover';

config();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

async function listRunningWorkflowIds(queue: string): Promise<string[]> {
  const client = await getTemporalClient();
  const query = `TaskQueue = "${queue}" AND ExecutionStatus = "Running"`;
  const ids: string[] = [];
  for await (const execution of client.workflow.list({ query })) {
    ids.push(execution.workflowId);
  }
  return ids;
}

async function mapConcurrently<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      await task(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, worker)
  );
}

async function main(): Promise<void> {
  const queue = argValue('--queue')?.trim();
  if (!queue) {
    process.stderr.write(
      'Usage: force-clear-generation-queue.ts --queue navi-agent-tasks@<hash> --execute\n'
    );
    process.exit(2);
  }
  if (!process.argv.includes('--execute')) {
    throw new Error('Refusing to mutate workflows without --execute');
  }

  const concurrency = positiveInteger(process.env.WORKFLOW_MIGRATION_CONCURRENCY, 16);
  const workflowIds = await listRunningWorkflowIds(queue);
  process.stdout.write(`Found ${workflowIds.length} running workflow(s) on ${queue}\n`);

  const summary = { cleared: 0, skipped: 0, failed: 0 };
  await mapConcurrently(workflowIds, concurrency, async (workflowId) => {
    const outcome = await clearSupersededGenerationWorkflow(queue, workflowId);
    summary[outcome] += 1;
    process.stdout.write(`${outcome.toUpperCase()} ${workflowId}\n`);
  });

  const remaining = await listRunningWorkflowIds(queue);
  process.stdout.write(`${JSON.stringify({ queue, ...summary, remaining })}\n`);
  if (summary.failed > 0 || remaining.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
