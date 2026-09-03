#!/usr/bin/env tsx
/**
 * Break-glass: terminate running workflows still on a superseded generation queue.
 *
 * Cooperative cutover waits up to 45 minutes for continue_as_new handoff. Stragglers
 * that never hand off (old-gen worker code, paused agents, verifier-less roots) are
 * cleared here instead of `migrate-open-agent-workflows.ts`, which requires a
 * verifier and targets deployment replacement rather than generation drain.
 *
 * Usage:
 *   force-clear-generation-queue.ts --queue navi-agent-tasks@<oldHash> --execute
 */
import { config } from 'dotenv';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma } from '../src/providers/database';
import { getTemporalClient, resolveTemporalWorkflowExecutionRef } from '../src/providers/temporal';
import {
  captureInProgressWorkflowTools,
  finalizeInterruptedWorkflowTools,
} from '../src/providers/staleWorkflowTools';
import { terminateStaleTemporalWorkflow } from '../src/providers/workflowReplacement';
import { lockAgentWorkflowGeneration } from '../src/providers/workflowGeneration';
import { runTransactionWithRetry } from '../src/providers/database';

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

async function clearOne(
  queue: string,
  workflowId: string
): Promise<'cleared' | 'skipped' | 'failed'> {
  const agent = await prisma.agent.findFirst({
    where: { deletedAt: null, temporalWorkflowId: workflowId },
    select: { id: true, status: true, temporalWorkflowId: true },
  });

  try {
    if (agent !== null && agent.temporalWorkflowId === workflowId) {
      const execution = await resolveTemporalWorkflowExecutionRef(workflowId);
      const snapshot = await captureInProgressWorkflowTools(agent.id, workflowId);
      await terminateStaleTemporalWorkflow(execution, agent.id);
      await finalizeInterruptedWorkflowTools(agent.id, workflowId, snapshot);
      await runTransactionWithRetry(async (tx) => {
        await lockAgentWorkflowGeneration(tx, agent.id);
        await tx.agent.update({
          where: { id: agent.id },
          data: {
            status: 'FAILED',
            statusMessage: `Generation cutover: terminated workflow still on superseded queue ${queue}`,
            toolsInUse: [],
          },
        });
      });
      process.stdout.write(`CLEARED ${agent.id} ${workflowId}\n`);
      return 'cleared';
    }

    const client = await getTemporalClient();
    try {
      await client.workflow.getHandle(workflowId).terminate(
        `Generation cutover: orphan workflow on superseded queue ${queue}`
      );
      process.stdout.write(`CLEARED orphan ${workflowId}\n`);
      return 'cleared';
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        process.stdout.write(`SKIP not-found ${workflowId}\n`);
        return 'skipped';
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`FAILED ${workflowId}: ${message}\n`);
    return 'failed';
  }
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
    const outcome = await clearOne(queue, workflowId);
    summary[outcome] += 1;
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
