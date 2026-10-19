#!/usr/bin/env tsx
/**
 * Signal running AgentWorkflows on a superseded queue that the live generation moved.
 *
 * Run after every AgentQueuePointer flip (worker_pool_cutover.py DRAINING stage,
 * deploy-existing-worker-processes.ts activate, or a manual
 * set-agent-queue-pointer.ts flip/rollback). Idempotent and best-effort: a
 * missed workflow hands off at its next turn or idle safety re-check.
 *
 * Usage:
 *   broadcast-generation-handoff.ts --from-queue <old> [--live-queue <live>]
 *       [--batch-size 100] [--signals-per-second 200] [--deadline-ms 120000]
 *
 * --live-queue defaults to the current pointer; when given it must equal the
 * pointer (a stale broadcast after a rollback is refused). Prints one JSON report.
 */
import { config } from 'dotenv';
import { readAgentQueuePointer } from '../src/providers/agentQueuePointer';
import { prisma } from '../src/providers/database';
import { broadcastGenerationHandoff } from '../src/providers/generationHandoffBroadcast';

config();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numberArg(flag: string): number | undefined {
  const raw = argValue(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`);
  return value;
}

async function main(): Promise<void> {
  const fromQueue = argValue('--from-queue');
  if (!fromQueue) {
    process.stderr.write(
      'Usage: broadcast-generation-handoff.ts --from-queue <old> [--live-queue <live>]\n'
    );
    process.exitCode = 2;
    return;
  }
  const pointer = await readAgentQueuePointer();
  const liveQueue = argValue('--live-queue') ?? pointer?.taskQueue;
  if (!pointer || !liveQueue || pointer.taskQueue !== liveQueue)
    throw new Error(
      `Live pointer ${pointer?.taskQueue ?? '<none>'} differs from --live-queue ${liveQueue ?? '<none>'}`
    );
  const report = await broadcastGenerationHandoff({
    fromQueue,
    liveQueue,
    batchSize: numberArg('--batch-size'),
    signalsPerSecond: numberArg('--signals-per-second'),
    deadlineMs: numberArg('--deadline-ms'),
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
