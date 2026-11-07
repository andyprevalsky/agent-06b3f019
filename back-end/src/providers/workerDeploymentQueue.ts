export * from './workerDeploymentMachineAdmission';
export * from './workerDeploymentSupersession';
import {
  installWorkerRouteRetention,
  requireWorkerMachineNotRetained,
  requireRetainedDisposition,
  WORKER_PRIOR_DISPOSITIONS,
  requireRetainedPreparation,
  requireRetiredQueue,
} from './workerDeploymentRetention';
/** Durable deploy control plane only: no agent hot-path reads or native side effects. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { lockQueueAdmission } from './workflowQueueAdmission';
import { WORKFLOW_DEPLOYMENT_LEASE_KEY } from './workflowDeploymentLease';

const JOB = 'WORKER_DEPLOYMENT_JOB';
const RESERVATION = 'WORKER_DEPLOYMENT_RESERVATION';
export const WORKER_DEPLOYMENT_STAGES = [
  'QUEUED',
  'PREPARING',
  'READY',
  'ACTIVATED',
  'DRAINING',
  'SUCCEEDED',
  'ABORTED',
  // Terminal for a never-started QUEUED job whose code ships in a queued git
  // descendant's cutover (evidence.SUPERSEDED.supersededBy names that job).
  'SUPERSEDED',
] as const;
export type WorkerDeploymentStage = (typeof WORKER_DEPLOYMENT_STAGES)[number];
export const TERMINAL_WORKER_DEPLOYMENT_STAGES: readonly WorkerDeploymentStage[] = [
  'SUCCEEDED',
  'ABORTED',
  'SUPERSEDED',
];
const terminal = (stage: WorkerDeploymentStage) =>
  TERMINAL_WORKER_DEPLOYMENT_STAGES.includes(stage);
/** FIFO coalescing reads at most this many pending jobs per app. */
const MAX_PENDING_JOBS = 64;
export interface WorkerDeploymentIdentity {
  app: string;
  sourceCommit: string;
  buildId: string;
  surfaceHash: string;
  attempt: string;
  imageRef: string;
}
export interface WorkerDeploymentPreparation {
  priorPointer: { taskQueue: string; surfaceHash: string } | null;
  candidateMachineIds: string[];
  evidence?: Record<string, Prisma.JsonValue>;
}
export interface WorkerDeploymentJob extends WorkerDeploymentPreparation {
  version: 1;
  jobId: string;
  identity: WorkerDeploymentIdentity;
  stage: WorkerDeploymentStage;
  ownerId: string | null;
  evidence: Record<string, Prisma.JsonValue>;
  failure: { message: string; at: string } | null;
}
type Transaction = Prisma.TransactionClient;
export function workerDeploymentQueueName(jobId: string, surfaceHash: string): string {
  return `navi-agent-tasks-pool-${createHash('sha256').update(jobId).digest('hex').slice(0, 12)}@${surfaceHash}`;
}
const json = (value: unknown) => value as Prisma.InputJsonObject;
const key = (jobId: string) => `deployment:worker-job:${jobId}`;
const reservationKey = (app: string, id: string) => `deployment:worker-machine:${app}:${id}`;
const appLock = (app: string) => `deployment:worker-queue:${app}`;

function identityHash(identity: WorkerDeploymentIdentity): string {
  const values = ['app', 'sourceCommit', 'buildId', 'surfaceHash', 'attempt', 'imageRef'] as const;
  if (
    Object.keys(identity).length !== values.length ||
    values.some((k) => typeof identity[k] !== 'string' || !identity[k] || identity[k].length > 512)
  )
    throw new Error('Invalid immutable deployment identity');
  if (
    !/^[a-z0-9-]+$/.test(identity.app) ||
    !/^[a-f0-9]{40}$/.test(identity.sourceCommit) ||
    identity.buildId !== identity.sourceCommit ||
    !/^[a-f0-9]{12}$/.test(identity.surfaceHash) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(identity.attempt) ||
    !/^registry\.fly\.io\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(identity.imageRef) ||
    !identity.imageRef.startsWith(`registry.fly.io/${identity.app}@`)
  )
    throw new Error('Deployment requires exact source and immutable image digest');
  return createHash('sha256')
    .update(JSON.stringify(values.map((k) => [k, identity[k]])))
    .digest('hex');
}
function decode(value: Prisma.JsonValue | null): WorkerDeploymentJob {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed durable deployment job');
  const job = value as unknown as WorkerDeploymentJob;
  if (
    job.version !== 1 ||
    identityHash(job.identity) !== job.jobId ||
    !WORKER_DEPLOYMENT_STAGES.includes(job.stage) ||
    !Array.isArray(job.candidateMachineIds)
  )
    throw new Error('Malformed durable deployment job');
  return job;
}
/** Validated decode of a durable job row (shared with the supersession module). */
export const decodeWorkerDeploymentJob = (value: Prisma.JsonValue | null) => decode(value);
async function now(tx: Transaction): Promise<Date> {
  return (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
}
export async function requireWorkerDeploymentLease(
  tx: Transaction,
  ownerId: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${WORKFLOW_DEPLOYMENT_LEASE_KEY}))`;
  const lease = await tx.toolSideEffect.findUnique({
    where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
  });
  const ms = (lease?.request as { leaseMs?: number } | null)?.leaseMs;
  if (
    !lease ||
    lease.operationType !== 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE' ||
    lease.status !== 'STARTED' ||
    lease.externalId !== ownerId ||
    typeof ms !== 'number' ||
    !Number.isFinite(ms) ||
    ms <= 0 ||
    lease.updatedAt.getTime() + ms <= (await now(tx)).getTime()
  )
    throw new Error('Deployment lease is stale or not owned');
}
export async function readWorkerDeployment(jobId: string): Promise<WorkerDeploymentJob> {
  const row = await prisma.toolSideEffect.findUnique({ where: { operationKey: key(jobId) } });
  if (!row || row.operationType !== JOB) throw new Error('Deployment job does not exist');
  return decode(row.request);
}
async function head(
  tx: Pick<Transaction, 'toolSideEffect'>,
  app: string
): Promise<WorkerDeploymentJob | null> {
  const row = await tx.toolSideEffect.findFirst({
    where: {
      operationType: JOB,
      externalId: app,
      status: { notIn: [...TERMINAL_WORKER_DEPLOYMENT_STAGES] },
    },
    orderBy: [{ createdAt: 'asc' }, { operationKey: 'asc' }],
  });
  return row ? decode(row.request) : null;
}
export async function readPendingWorkerDeployments(
  tx: Pick<Transaction, 'toolSideEffect'>,
  app: string
): Promise<WorkerDeploymentJob[]> {
  const rows = await tx.toolSideEffect.findMany({
    where: {
      operationType: JOB,
      externalId: app,
      status: { notIn: [...TERMINAL_WORKER_DEPLOYMENT_STAGES] },
    },
    orderBy: [{ createdAt: 'asc' }, { operationKey: 'asc' }],
    take: MAX_PENDING_JOBS,
  });
  return rows.map((row) => decode(row.request));
}
/** Non-terminal jobs for one app in FIFO order (head first, bounded). */
export async function readWorkerDeploymentQueue(app: string): Promise<WorkerDeploymentJob[]> {
  return readPendingWorkerDeployments(prisma, app);
}
export async function readWorkerDeploymentHead(app: string): Promise<WorkerDeploymentJob | null> {
  return head(prisma, app);
}
export async function enqueueWorkerDeployment(
  identity: WorkerDeploymentIdentity
): Promise<WorkerDeploymentJob> {
  const jobId = identityHash(identity);
  return runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${appLock(identity.app)}))`;
    const existing = await tx.toolSideEffect.findUnique({ where: { operationKey: key(jobId) } });
    if (existing) return decode(existing.request);
    const last = await tx.toolSideEffect.findFirst({
      where: { operationType: JOB, externalId: identity.app },
      orderBy: { createdAt: 'desc' },
    });
    const createdAt = new Date(
      Math.max((await now(tx)).getTime(), (last?.createdAt.getTime() ?? 0) + 1)
    );
    const job: WorkerDeploymentJob = {
      version: 1,
      jobId,
      identity,
      stage: 'QUEUED',
      priorPointer: null,
      candidateMachineIds: [],
      ownerId: null,
      evidence: {},
      failure: null,
    };
    await tx.toolSideEffect.create({
      data: {
        operationKey: key(jobId),
        operationType: JOB,
        externalId: identity.app,
        status: job.stage,
        request: json(job),
        createdAt,
      },
    });
    return job;
  });
}
async function mutation(
  jobId: string,
  ownerId: string,
  fn: (tx: Transaction, job: WorkerDeploymentJob) => Promise<WorkerDeploymentJob>
): Promise<WorkerDeploymentJob> {
  return runTransactionWithRetry(async (tx) => {
    await requireWorkerDeploymentLease(tx, ownerId);
    const row = await tx.toolSideEffect.findUnique({ where: { operationKey: key(jobId) } });
    if (!row || row.operationType !== JOB) throw new Error('Deployment job does not exist');
    const job = decode(row.request);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${appLock(job.identity.app)}))`;
    if (!terminal(job.stage) && (await head(tx, job.identity.app))?.jobId !== jobId)
      throw new Error('FIFO predecessor must complete before this deployment');
    const result = await fn(tx, job);
    await tx.toolSideEffect.update({
      where: { operationKey: key(jobId) },
      data: {
        status: result.failure ? 'FAILED' : result.stage,
        request: json(result),
        error: result.failure?.message ?? null,
      },
    });
    return result;
  });
}
function samePreparation(a: WorkerDeploymentPreparation, b: WorkerDeploymentPreparation): boolean {
  return (
    a.priorPointer?.taskQueue === b.priorPointer?.taskQueue &&
    a.priorPointer?.surfaceHash === b.priorPointer?.surfaceHash &&
    JSON.stringify(a.candidateMachineIds) === JSON.stringify(b.candidateMachineIds) &&
    isDeepStrictEqual(a.evidence?.PREPARING ?? {}, b.evidence ?? {})
  );
}
export async function prepareWorkerDeployment(
  jobId: string,
  plan: WorkerDeploymentPreparation,
  ownerId: string
): Promise<WorkerDeploymentJob> {
  const ids = plan.candidateMachineIds;
  if (
    !Array.isArray(ids) ||
    ids.length !== 8 ||
    ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new Error('Invalid exact candidate machine set');
  if (
    !plan.priorPointer ||
    typeof plan.priorPointer.taskQueue !== 'string' ||
    !plan.priorPointer.taskQueue ||
    typeof plan.priorPointer.surfaceHash !== 'string' ||
    !plan.priorPointer.surfaceHash
  )
    throw new Error('Invalid prior pointer');
  const records = plan.evidence?.candidateRecords;
  if (
    !Array.isArray(records) ||
    records.length !== 8 ||
    !records.every(
      (record) =>
        record &&
        typeof record === 'object' &&
        !Array.isArray(record) &&
        typeof record.id === 'string' &&
        ids.includes(record.id) &&
        typeof record.instanceId === 'string' &&
        record.instanceId.length > 0 &&
        typeof record.configSHA256 === 'string' &&
        /^[a-f0-9]{64}$/.test(record.configSHA256)
    ) ||
    new Set(records.map((record) => (record as Record<string, Prisma.JsonValue>).id)).size !== 8
  )
    throw new Error('Exact candidate records must bind every native machine version/config');

  return mutation(jobId, ownerId, async (tx, job) => {
    if (job.stage !== 'QUEUED') {
      if (!samePreparation(job, plan))
        throw new Error('Prepared deployment bank and prior pointer are immutable');
      await requireRetainedPreparation(tx, job);
      return { ...job, ownerId, failure: null };
    }
    await lockQueueAdmission(tx);
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    if (
      pointer?.taskQueue !== plan.priorPointer?.taskQueue ||
      pointer?.surfaceHash !== plan.priorPointer?.surfaceHash
    )
      throw new Error('Prior pointer changed before atomic bank reservation');
    for (const id of ids) await requireWorkerMachineNotRetained(tx, job.identity.app, id);
    await installWorkerRouteRetention(tx, job, plan);
    for (const id of [...ids].sort()) {
      const operationKey = reservationKey(job.identity.app, id);
      const prior = await tx.toolSideEffect.findUnique({ where: { operationKey } });
      if (
        prior &&
        prior.status !== 'RELEASED' &&
        (prior.request as { jobId?: string } | null)?.jobId !== jobId
      )
        throw new Error(`Machine ${id} remains reserved or active`);
      const data = {
        operationType: RESERVATION,
        externalId: job.identity.app,
        status: 'RESERVED',
        request: json({ jobId, machineId: id, identity: job.identity }),
      };
      await tx.toolSideEffect.upsert({
        where: { operationKey },
        create: { operationKey, ...data },
        update: data,
      });
    }
    return {
      ...job,
      priorPointer: {
        taskQueue: plan.priorPointer!.taskQueue,
        surfaceHash: plan.priorPointer!.surfaceHash,
      },
      candidateMachineIds: [...ids],
      evidence: { PREPARING: plan.evidence ?? {} },
      stage: 'PREPARING',
      ownerId,
      failure: null,
    };
  });
}
export async function transitionWorkerDeployment(
  jobId: string,
  expected: WorkerDeploymentStage,
  next: WorkerDeploymentStage,
  evidence: Record<string, Prisma.JsonValue>,
  ownerId: string
): Promise<WorkerDeploymentJob> {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence))
    throw new Error('Stage evidence must be an object');
  return mutation(jobId, ownerId, async (tx, job) => {
    if (job.stage === next) {
      if (!isDeepStrictEqual(job.evidence[next], evidence))
        throw new Error('Committed stage evidence is immutable');
      return { ...job, ownerId };
    }
    if (
      next === 'ABORTED' ||
      expected === 'ABORTED' ||
      next === 'SUPERSEDED' ||
      terminal(job.stage) ||
      job.stage !== expected ||
      WORKER_DEPLOYMENT_STAGES.indexOf(next) !== WORKER_DEPLOYMENT_STAGES.indexOf(expected) + 1
    )
      throw new Error('Invalid deployment stage transition');
    if (next === 'ACTIVATED' || next === 'SUCCEEDED') {
      const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
      if (
        pointer?.surfaceHash !== job.identity.surfaceHash ||
        pointer.taskQueue !== workerDeploymentQueueName(job.jobId, job.identity.surfaceHash)
      )
        throw new Error('Target pointer does not match the deployment');
    }
    if (next === 'SUCCEEDED') {
      if (
        evidence.candidateHealthy !== true ||
        !WORKER_PRIOR_DISPOSITIONS.includes(String(evidence.priorDisposition))
      )
        throw new Error(
          'Deployment completion needs explicit active bank and prior disposition evidence'
        );
      await requireRetainedDisposition(tx, job, evidence);
      if (evidence.priorDisposition !== 'RETAINED_LEGACY') await requireRetiredQueue(tx, job);
      const oldRecords = (
        job.evidence.PREPARING as { previousRecords?: Array<{ managedJobId?: string }> } | undefined
      )?.previousRecords;
      if (
        evidence.priorDisposition === 'RETAINED_LEGACY' &&
        oldRecords?.some((record) => record.managedJobId)
      )
        throw new Error('Managed prior bank requires certified retirement');
      for (const id of job.candidateMachineIds) {
        const changed = await tx.toolSideEffect.updateMany({
          where: {
            operationKey: reservationKey(job.identity.app, id),
            status: 'RESERVED',
            request: { path: ['jobId'], equals: jobId },
          },
          data: { status: 'ACTIVE' },
        });
        if (changed.count !== 1)
          throw new Error('Candidate reservation changed before activation completion');
      }
    }
    return {
      ...job,
      stage: next,
      ownerId,
      evidence: { ...job.evidence, [next]: evidence },
      failure: null,
    };
  });
}
export async function recordWorkerDeploymentFailure(
  jobId: string,
  message: string,
  ownerId: string
): Promise<WorkerDeploymentJob> {
  return mutation(jobId, ownerId, async (tx, job) => {
    if (terminal(job.stage)) return job;
    return {
      ...job,
      ownerId,
      failure: { message: message.slice(0, 2000), at: (await now(tx)).toISOString() },
    };
  });
}
export async function releaseRetiredWorkerMachines(
  jobId: string,
  machines: Array<{
    machineId: string;
    previousJobId: string;
    instanceId: string;
    configSHA256: string;
    retiredQueue: string;
    certificateRef: string;
  }>,
  ownerId: string
): Promise<WorkerDeploymentJob> {
  return mutation(jobId, ownerId, async (tx, job) => {
    if (!['DRAINING', 'SUCCEEDED'].includes(job.stage))
      throw new Error('Machine release requires draining deployment');
    for (const machine of machines)
      await requireWorkerMachineNotRetained(tx, job.identity.app, machine.machineId);
    await requireRetiredQueue(tx, job);
    for (const machine of machines) {
      const previous = await tx.toolSideEffect.findUnique({
        where: { operationKey: key(machine.previousJobId) },
      });
      const previousJob = previous ? decode(previous.request) : null;
      if (
        !previousJob ||
        previousJob.identity.app !== job.identity.app ||
        workerDeploymentQueueName(previousJob.jobId, previousJob.identity.surfaceHash) !==
          machine.retiredQueue
      )
        throw new Error('Prior machine belongs to another deployment queue');
      if (
        !machine.instanceId ||
        !/^[a-f0-9]{64}$/.test(machine.configSHA256) ||
        !machine.certificateRef ||
        machine.retiredQueue !== job.priorPointer?.taskQueue
      )
        throw new Error('Exact machine and source retirement certificate required');
      if (job.candidateMachineIds.includes(machine.machineId))
        throw new Error('Cannot release the serving candidate bank');
      const operationKey = reservationKey(job.identity.app, machine.machineId);
      const priorRelease = await tx.toolSideEffect.findUnique({ where: { operationKey } });
      if (
        priorRelease?.status === 'RELEASED' &&
        isDeepStrictEqual(priorRelease.response, { retiredBy: jobId, ...machine })
      )
        continue;
      const changed = await tx.toolSideEffect.updateMany({
        where: {
          operationKey,
          status: 'ACTIVE',
          request: { path: ['jobId'], equals: machine.previousJobId },
        },
        data: { status: 'RELEASED', response: json({ retiredBy: jobId, ...machine }) },
      });
      if (changed.count !== 1) throw new Error('Prior managed bank ownership changed');
    }
    return {
      ...job,
      ownerId,
      evidence: { ...job.evidence, releasedMachines: machines as unknown as Prisma.JsonValue },
      failure: null,
    };
  });
}

/** Audit-only loss record grants no authority and never changes jobs or reservations. */
export async function recordWorkerDeploymentLeaseLoss(
  jobId: string,
  ownerId: string,
  message: string
): Promise<void> {
  const operationKey = `deployment:worker-lease-loss:${jobId}:${ownerId}`;
  await prisma.toolSideEffect.upsert({
    where: { operationKey },
    create: {
      operationKey,
      operationType: 'WORKER_DEPLOYMENT_EVENT',
      externalId: jobId,
      status: 'LEASE_LOST',
      error: message.slice(0, 2000),
    },
    update: {},
  });
}

/** Transfer controller custody only under the fresh global lease and FIFO lock. */
export async function claimWorkerDeployment(
  jobId: string,
  ownerId: string
): Promise<WorkerDeploymentJob> {
  return mutation(jobId, ownerId, async (_tx, job) => {
    if (terminal(job.stage)) throw new Error('Terminal deployment cannot be claimed');
    return { ...job, ownerId };
  });
}

/** Fresh global lease and FIFO ownership immediately before each native action. */
export async function assertWorkerDeploymentOwned(
  jobId: string,
  ownerId: string
): Promise<WorkerDeploymentJob> {
  return runTransactionWithRetry(async (tx) => {
    await requireWorkerDeploymentLease(tx, ownerId);
    const row = await tx.toolSideEffect.findUnique({ where: { operationKey: key(jobId) } });
    if (!row || row.operationType !== JOB) throw new Error('Deployment job does not exist');
    const job = decode(row.request);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${appLock(job.identity.app)}))`;
    if (terminal(job.stage) || (await head(tx, job.identity.app))?.jobId !== jobId)
      throw new Error('FIFO head no longer owns native admission');
    return job;
  });
}

/** Only untouched queued jobs can be cancelled without a separate native quiescence proof. */
export async function abortWorkerDeployment(
  jobId: string,
  reason: string,
  ownerId: string
): Promise<WorkerDeploymentJob> {
  return mutation(jobId, ownerId, async (tx, job) => {
    if (job.stage === 'ABORTED') return job;
    if (job.stage === 'SUPERSEDED')
      throw new Error('Superseded deployment is already terminal; its descendant owns the cutover');
    if (job.stage !== 'QUEUED' || job.candidateMachineIds.length)
      throw new Error(
        'Prepared or activated deployment requires explicit native reconciliation before abort'
      );
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    if (pointer?.taskQueue === workerDeploymentQueueName(job.jobId, job.identity.surfaceHash))
      throw new Error('Cannot abort a serving deployment');
    return {
      ...job,
      stage: 'ABORTED',
      ownerId,
      failure: null,
      evidence: { ...job.evidence, ABORTED: { reason } },
    };
  });
}

/** Explicit candidate abandonment requires the real target admission tombstone and native records. */
export async function abortPreparedWorkerDeployment(
  jobId: string,
  proof: {
    machineRecords: Array<{ id: string; instanceId: string; configSHA256: string }>;
    reason: string;
  },
  ownerId: string
): Promise<WorkerDeploymentJob> {
  return mutation(jobId, ownerId, async (tx, job) => {
    if (job.stage === 'ABORTED') {
      if (!isDeepStrictEqual(job.evidence.ABORTED, proof))
        throw new Error('Abandonment proof changed');
      return job;
    }
    if (!['PREPARING', 'READY'].includes(job.stage))
      throw new Error('Only never-published candidates may be abandoned');
    const queue = workerDeploymentQueueName(job.jobId, job.identity.surfaceHash);
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    if (pointer?.taskQueue === queue) throw new Error('Cannot abandon a serving candidate');
    await requireRetiredQueue(tx, job, queue);
    const records = proof.machineRecords;
    if (
      !Array.isArray(records) ||
      records.length !== 8 ||
      new Set(records.map((record) => record.id)).size !== 8 ||
      !records.every(
        (record) =>
          job.candidateMachineIds.includes(record.id) &&
          record.instanceId &&
          /^[a-f0-9]{64}$/.test(record.configSHA256)
      )
    )
      throw new Error('Abandonment needs exact eight native retirement records');
    for (const record of records) {
      await requireWorkerMachineNotRetained(tx, job.identity.app, record.id);
      const changed = await tx.toolSideEffect.updateMany({
        where: {
          operationKey: reservationKey(job.identity.app, record.id),
          status: 'RESERVED',
          request: { path: ['jobId'], equals: jobId },
        },
        data: { status: 'RELEASED', response: json({ abandonedBy: jobId, queue, record }) },
      });
      if (changed.count !== 1) throw new Error('Candidate reservation changed before abandonment');
    }
    return {
      ...job,
      stage: 'ABORTED',
      ownerId,
      failure: null,
      evidence: { ...job.evidence, ABORTED: proof },
    };
  });
}
