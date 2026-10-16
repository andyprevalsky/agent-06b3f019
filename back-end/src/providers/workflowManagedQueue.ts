import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { runTransactionWithRetry } from './database';
import { WORKFLOW_DEPLOYMENT_LEASE_KEY } from './workflowDeploymentLease';
import {
  lockQueueAdmission,
  queueAdmissionKey,
  QUEUE_ADMISSION_OPERATION,
  type QueueAdmission,
  WorkflowStartAdmissionPendingError,
} from './workflowQueueAdmission';
export const MANAGED_PRODUCER_PROTOCOL = 'immutable-start-and-native-continuation-v1';
export const managedQueue = (queue: string) =>
  /^navi-agent-tasks-pool-[a-f0-9]{12}@[a-f0-9]{12}$/.test(queue);
export interface ManagedQueueInitialization {
  queue: string;
  surfaceHash: string;
  jobId: string;
  sourceCommit: string;
}
export async function initializeManagedQueue(
  input: ManagedQueueInitialization,
  ownerId: string,
  options: { forRetirement?: boolean } = {}
): Promise<void> {
  if (
    !ownerId ||
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    !/^[a-f0-9]{12}$/.test(input.surfaceHash) ||
    input.queue !==
      `navi-agent-tasks-pool-${createHash('sha256').update(input.jobId).digest('hex').slice(0, 12)}@${input.surfaceHash}` ||
    !input.jobId
  )
    throw new WorkflowStartAdmissionPendingError('Managed queue identity is unqualified');
  await runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${WORKFLOW_DEPLOYMENT_LEASE_KEY}))`;
    const lease = await tx.toolSideEffect.findUnique({
      where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
    });
    const ms = (lease?.request as { leaseMs?: number } | null)?.leaseMs;
    const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
    if (
      !lease ||
      lease.operationType !== 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE' ||
      lease.status !== 'STARTED' ||
      lease.externalId !== ownerId ||
      typeof ms !== 'number' ||
      !Number.isFinite(ms) ||
      ms <= 0 ||
      lease.updatedAt.getTime() + ms <= now.getTime()
    )
      throw new WorkflowStartAdmissionPendingError('Deployment lease is stale or not owned');
    const jobRow = await tx.toolSideEffect.findUnique({
      where: { operationKey: `deployment:worker-job:${input.jobId}` },
    });
    const job = jobRow?.request as
      | {
          version?: number;
          jobId?: string;
          ownerId?: string;
          stage?: string;
          identity?: { sourceCommit?: string; surfaceHash?: string };
        }
      | undefined;
    if (
      jobRow?.operationType !== 'WORKER_DEPLOYMENT_JOB' ||
      job?.version !== 1 ||
      job.jobId !== input.jobId ||
      job.ownerId !== ownerId ||
      !['PREPARING', 'READY'].includes(job.stage ?? '') ||
      job.identity?.sourceCommit !== input.sourceCommit ||
      job.identity?.surfaceHash !== input.surfaceHash
    )
      throw new WorkflowStartAdmissionPendingError(
        'Managed queue has no matching owned deployment job'
      );
    await lockQueueAdmission(tx);
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    if (options.forRetirement === true && pointer?.taskQueue === input.queue)
      throw new WorkflowStartAdmissionPendingError('Current live queue cannot be retired');
    const prior = (
      await tx.toolSideEffect.findUnique({
        where: { operationKey: queueAdmissionKey(input.queue) },
      })
    )?.request as unknown as QueueAdmission | undefined;
    if (prior) {
      if (
        prior.version === 1 &&
        prior.queue === input.queue &&
        prior.incarnation &&
        (prior.phase === 'OPEN' ||
          (options.forRetirement === true && ['RETIRING', 'RETIRED'].includes(prior.phase))) &&
        prior.surfaceHash === input.surfaceHash &&
        prior.legacyCoverage === 'QUALIFIED' &&
        prior.legacyCertificate?.producerTransition ===
          `${MANAGED_PRODUCER_PROTOCOL}:${input.sourceCommit}` &&
        prior.legacyCertificate?.cohortManifest === `fresh:${input.jobId}` &&
        prior.legacyCertificate?.unresolved === 0
      )
        return;
      throw new WorkflowStartAdmissionPendingError(
        'Managed queue is not fresh or its retained identity differs'
      );
    }
    if (pointer?.taskQueue === input.queue)
      throw new WorkflowStartAdmissionPendingError('Managed queue was already published');
    const membership = await tx.toolSideEffect.findFirst({
      where: {
        operationType: { in: ['AGENT_QUEUE_START', 'AGENT_QUEUE_CONTINUATION'] },
        request: { path: ['queue'], equals: input.queue },
      },
    });
    if (membership)
      throw new WorkflowStartAdmissionPendingError('Managed queue already has producer membership');
    const state: QueueAdmission = {
      version: 1,
      queue: input.queue,
      incarnation: randomUUID(),
      phase: 'OPEN',
      owner: ownerId,
      surfaceHash: input.surfaceHash,
      legacyCoverage: 'QUALIFIED',
      legacyCertificate: {
        producerTransition: `${MANAGED_PRODUCER_PROTOCOL}:${input.sourceCommit}`,
        cohortManifest: `fresh:${input.jobId}`,
        unresolved: 0,
      },
    };
    await tx.toolSideEffect.create({
      data: {
        operationKey: queueAdmissionKey(input.queue),
        operationType: QUEUE_ADMISSION_OPERATION,
        externalId: input.queue,
        status: 'OPEN',
        request: state as unknown as Prisma.InputJsonObject,
      },
    });
  });
}
