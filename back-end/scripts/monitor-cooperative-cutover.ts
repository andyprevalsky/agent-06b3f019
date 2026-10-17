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
import {
  readWorkerDeployment,
  readWorkerDeploymentRetainedRouteMismatch,
  workerDeploymentQueueName,
} from '../src/providers/workerDeploymentQueue';
import { queueAdmissionKey, type QueueAdmission } from '../src/providers/workflowQueueAdmission';

config();

const TERMINAL = ['COMPLETED', 'FAILED'] as const;

type CutoverPhase =
  | 'awaiting_pointer_flip'
  | 'draining_old_generation'
  | 'cooperative_drain_complete'
  | 'same_generation'
  | 'managed_deployment_pending'
  | 'retained_legacy_generation'
  | 'retained_route_mismatch';

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
  deploymentJobId?: string;
  retainedRouteMismatch?: {
    machineIds: string[];
    actualQueues: string[];
    unresolved: number;
    retirementComplete: false;
  };
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
    for await (const execution of client.workflow.list({ query })) {
      void execution;
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
      messages.push(
        `Live pointer on expected generation ${expectedHash} (rolling/same-hash deploy).`
      );
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
      messages.push(
        `VERIFY FAILED: old queue ${oldQueue} still has ${oldQueueOpenCount} open workflow(s).`
      );
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

async function buildManagedReport(jobId: string, expectedHash?: string): Promise<CutoverReport> {
  const job = await readWorkerDeployment(jobId);
  if (expectedHash && expectedHash !== job.identity.surfaceHash)
    throw new Error('Deployment job does not match the expected source surface');
  const expectedQueue = workerDeploymentQueueName(jobId, job.identity.surfaceHash);
  const row = await readAgentQueuePointer();
  const livePointer = {
    taskQueue: row?.taskQueue ?? null,
    surfaceHash: row?.surfaceHash ?? null,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
  const pointerMatchesExpected =
    livePointer.taskQueue === expectedQueue && livePointer.surfaceHash === job.identity.surfaceHash;
  const evidence = job.evidence.SUCCEEDED as Record<string, unknown> | undefined;
  const active = evidence?.activeMachineIds;
  const sameBank =
    Array.isArray(active) &&
    active.length === 8 &&
    new Set(active).size === 8 &&
    job.candidateMachineIds.length === 8 &&
    active.every((id) => typeof id === 'string' && job.candidateMachineIds.includes(id));
  let retired = false;
  if (
    ['RETIRED', 'RETAINED_ROUTE_MISMATCH'].includes(String(evidence?.priorDisposition)) &&
    job.priorPointer
  ) {
    const certificate = await prisma.toolSideEffect.findUnique({
      where: { operationKey: queueAdmissionKey(job.priorPointer.taskQueue) },
    });
    const gate = certificate?.request as unknown as QueueAdmission | undefined;
    retired = gate?.phase === 'RETIRED' && gate.legacyCoverage === 'QUALIFIED';
  }
  const retained = evidence?.priorDisposition === 'RETAINED_LEGACY';
  const mismatch =
    evidence?.priorDisposition === 'RETAINED_ROUTE_MISMATCH'
      ? await readWorkerDeploymentRetainedRouteMismatch(jobId)
      : undefined;
  const verifyOk =
    job.stage === 'SUCCEEDED' &&
    !job.failure &&
    pointerMatchesExpected &&
    sameBank &&
    evidence?.candidateHealthy === true &&
    (retained ||
      (retired &&
        (evidence?.priorDisposition === 'RETIRED' || Boolean(mismatch?.declaredQueueRetired))));
  return {
    phase: verifyOk
      ? mismatch
        ? 'retained_route_mismatch'
        : retained
          ? 'retained_legacy_generation'
          : 'cooperative_drain_complete'
      : 'managed_deployment_pending',
    deploymentJobId: jobId,
    ...(mismatch ? { retainedRouteMismatch: mismatch } : {}),
    expectedSurfaceHash: job.identity.surfaceHash,
    expectedQueue,
    livePointer,
    pointerMatchesExpected,
    oldQueue: job.priorPointer?.taskQueue ?? null,
    oldQueueOpenCount: null,
    verifyOk,
    messages: [
      `Durable job ${jobId}: ${job.stage}${job.failure ? ` (${job.failure.message})` : ''}.`,
      mismatch
        ? 'Managed route-mismatch cohort is held and unresolved; no work closure, retirement or reuse is certified.'
        : retained
          ? 'Legacy workers and their unfinished work remain served; no retirement certificate is claimed.'
          : 'A managed predecessor requires its durable qualified retirement certificate.',
    ],
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
  const jobId = argValue('--job-id');
  const oldQueue = argValue('--old-queue') ?? null;
  const verify = process.argv.includes('--verify');
  const asJson = process.argv.includes('--json');

  if (!expectedHash?.trim() && !jobId?.trim()) {
    process.stderr.write(
      'Usage: monitor-cooperative-cutover.ts --job-id <id> [--expected-hash <surfaceHash>] [--verify] [--json]\n'
    );
    process.exit(2);
  }

  const report = jobId
    ? await buildManagedReport(jobId.trim(), expectedHash?.trim())
    : await buildReport(expectedHash!.trim(), oldQueue?.trim() || null);

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
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
