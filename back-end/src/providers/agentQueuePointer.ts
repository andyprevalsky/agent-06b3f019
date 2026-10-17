import { fenceEmptyRetainedSource, routeMismatchRecords } from './workerDeploymentRetention';
/**
 * Current-generation agent task-queue pointer for zero-downtime cutover.
 *
 * New agent workflows route to the queue named here (`navi-agent-tasks@<surfaceHash>`).
 * The deploy cutover flips this atomically once new-generation workers are live,
 * so new work lands on the new fleet the instant it flips — no standby window.
 *
 * Backward-compatible: when the singleton row is ABSENT, `getCurrentAgentQueue`
 * falls back to `process.env.TEMPORAL_TASK_QUEUE` (today's behavior), so this is
 * inert until a cutover writes it.
 *
 * 10k-agent safety: the value is cached in-process with a short TTL, so this is a
 * ~O(1) memory read per workflow start, not a per-start DB query. A flip clears
 * this instance's cache immediately; other instances converge within the TTL —
 * which is why the cutover keeps old-generation workers alive past the TTL before
 * scaling them down (any lagged routing is still served).
 */
import { prisma, runTransactionWithRetry } from './database';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  lockQueueAdmission,
  queueAdmissionKey,
  QUEUE_ADMISSION_OPERATION,
  WorkflowStartAdmissionPendingError,
  type QueueAdmission,
} from './workflowQueueAdmission';
import { WORKFLOW_DEPLOYMENT_LEASE_KEY } from './workflowDeploymentLease';
import { managedQueue, MANAGED_PRODUCER_PROTOCOL } from './workflowManagedQueue';
import { workerDeploymentQueueName, type WorkerDeploymentJob } from './workerDeploymentQueue';

const SINGLETON_ID = 'singleton';

/** In-process cache TTL. Bounds cross-instance routing convergence after a flip. */
export const AGENT_QUEUE_POINTER_CACHE_TTL_MS = 5000;

interface QueueCache {
  queue: string;
  expiresAt: number;
}

let cache: QueueCache | null = null;

/** Test-only: clear the in-process cache so each case starts cold. */
export function __resetAgentQueuePointerCacheForTest(): void {
  cache = null;
}

/**
 * Resolve the task queue that a NEW agent workflow should start on.
 * Order: cached value → AgentQueuePointer row → TEMPORAL_TASK_QUEUE env.
 * Throws only if BOTH the row is absent AND the env is unset (never silently
 * routes nowhere). A genuine DB error propagates — we do not mask it.
 */
export async function getCurrentAgentQueue(now: number = Date.now()): Promise<string> {
  if (cache && cache.expiresAt > now) {
    return cache.queue;
  }
  const row = await prisma.agentQueuePointer.findUnique({
    where: { id: SINGLETON_ID },
  });
  const resolved = row?.taskQueue || process.env.TEMPORAL_TASK_QUEUE;
  if (!resolved) {
    throw new Error(
      'No agent task queue available: AgentQueuePointer is unset and TEMPORAL_TASK_QUEUE is not set'
    );
  }
  cache = { queue: resolved, expiresAt: now + AGENT_QUEUE_POINTER_CACHE_TTL_MS };
  return resolved;
}

/**
 * Atomically point new agent workflows at `taskQueue` (the new generation),
 * recording the surface hash that generation was built from. Called by the
 * deploy cutover after the new-generation workers are confirmed live. Clears the
 * local cache so this instance routes to the new queue immediately.
 */
export async function setCurrentAgentQueue(
  taskQueue: string,
  surfaceHash: string,
  updatedBy?: string,
  options?: { expectedCurrentQueue: string; deploymentOwnerId?: string }
): Promise<void> {
  if (managedQueue(taskQueue) && (!options?.deploymentOwnerId || !updatedBy))
    throw new Error('Managed queue publication requires its deployment job and lease owner');
  await runTransactionWithRetry(async (tx) => {
    let managedSource: string | undefined;
    let retainedJob: WorkerDeploymentJob | undefined;
    if (options?.deploymentOwnerId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${WORKFLOW_DEPLOYMENT_LEASE_KEY}))`;
      const lease = await tx.toolSideEffect.findUnique({
        where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
      });
      const databaseTime = (
        await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      )[0].now;
      const duration = (lease?.request as { leaseMs?: unknown } | null)?.leaseMs;
      if (
        lease?.status !== 'STARTED' ||
        lease.operationType !== 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE' ||
        lease.externalId !== options.deploymentOwnerId ||
        typeof duration !== 'number' ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        lease.updatedAt.getTime() + duration <= databaseTime.getTime()
      )
        throw new Error('Deployment no longer owns the production cutover lease');
    }
    if (managedQueue(taskQueue)) {
      const row = await tx.toolSideEffect.findUnique({
        where: { operationKey: `deployment:worker-job:${updatedBy}` },
      });
      const job = row?.request as
        | {
            jobId?: string;
            ownerId?: string;
            stage?: string;
            identity?: { surfaceHash?: string; sourceCommit?: string };
            candidateMachineIds?: string[];
            evidence?: { READY?: { healthyMachineIds?: string[] } };
          }
        | undefined;
      const candidates = job?.candidateMachineIds;
      const healthy = job?.evidence?.READY?.healthyMachineIds;
      if (
        row?.operationType !== 'WORKER_DEPLOYMENT_JOB' ||
        !job ||
        job.jobId !== updatedBy ||
        job.ownerId !== options?.deploymentOwnerId ||
        taskQueue !== workerDeploymentQueueName(updatedBy!, surfaceHash) ||
        job.stage !== 'READY' ||
        job.identity?.surfaceHash !== surfaceHash ||
        !/^[a-f0-9]{40}$/.test(job.identity.sourceCommit ?? '') ||
        !Array.isArray(candidates) ||
        candidates.length !== 8 ||
        new Set(candidates).size !== 8 ||
        !Array.isArray(healthy) ||
        healthy.length !== 8 ||
        new Set(healthy).size !== 8 ||
        !healthy.every((id) => candidates.includes(id))
      )
        throw new Error('Managed queue publication requires the exact ready candidate bank');
      managedSource = job.identity.sourceCommit;
      const fullJob = row.request as unknown as WorkerDeploymentJob;
      if (
        routeMismatchRecords(fullJob.evidence.PREPARING as Record<string, unknown> | undefined)
          .length
      ) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'deployment:worker-queue:' + fullJob.identity.app}))`;
        retainedJob = fullJob;
      }
    }
    await lockQueueAdmission(tx);
    if (options) {
      const current = await tx.agentQueuePointer.findUnique({ where: { id: SINGLETON_ID } });
      if (
        !current ||
        (current.taskQueue !== options.expectedCurrentQueue && current.taskQueue !== taskQueue) ||
        (current.taskQueue === taskQueue && current.surfaceHash !== surfaceHash)
      )
        throw new Error('Current queue changed before the qualified process cutover');
    }
    const key = queueAdmissionKey(taskQueue);
    const prior = await tx.toolSideEffect.findUnique({ where: { operationKey: key } });
    const saved = prior?.request as unknown as QueueAdmission | undefined;
    if (
      managedQueue(taskQueue) &&
      (prior?.operationType !== QUEUE_ADMISSION_OPERATION ||
        saved?.legacyCoverage !== 'QUALIFIED' ||
        saved.legacyCertificate?.cohortManifest !== `fresh:${updatedBy}` ||
        saved.legacyCertificate.producerTransition !==
          `${MANAGED_PRODUCER_PROTOCOL}:${managedSource}` ||
        saved.legacyCertificate.unresolved !== 0)
    )
      throw new WorkflowStartAdmissionPendingError(
        'Managed queue producer admission is unqualified'
      );
    if (
      saved &&
      (saved.version !== 1 ||
        saved.queue !== taskQueue ||
        saved.phase !== 'OPEN' ||
        saved.surfaceHash !== surfaceHash)
    )
      throw new WorkflowStartAdmissionPendingError(
        'Closed or mismatched queue requires separately qualified reactivation'
      );
    if (!saved) {
      const state: QueueAdmission = {
        version: 1,
        queue: taskQueue,
        incarnation: randomUUID(),
        owner: updatedBy ?? 'queue-pointer',
        phase: 'OPEN',
        surfaceHash,
        legacyCoverage: 'UNKNOWN',
      };
      await tx.toolSideEffect.create({
        data: {
          operationKey: key,
          operationType: QUEUE_ADMISSION_OPERATION,
          status: 'OPEN',
          externalId: taskQueue,
          request: state as unknown as Prisma.InputJsonObject,
        },
      });
    }
    if (retainedJob) {
      const current = await tx.agentQueuePointer.findUniqueOrThrow({ where: { id: SINGLETON_ID } });
      await fenceEmptyRetainedSource(tx, retainedJob, current, taskQueue);
    }
    await tx.agentQueuePointer.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, taskQueue, surfaceHash, updatedBy: updatedBy ?? null },
      update: { taskQueue, surfaceHash, updatedBy: updatedBy ?? null },
    });
  });
  cache = null;
}

/** Read the raw pointer row (or null). For deploy tooling / diagnostics. */
export async function readAgentQueuePointer(): Promise<{
  taskQueue: string;
  surfaceHash: string;
  updatedBy: string | null;
  updatedAt: Date;
} | null> {
  const row = await prisma.agentQueuePointer.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return null;
  return {
    taskQueue: row.taskQueue,
    surfaceHash: row.surfaceHash,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}
