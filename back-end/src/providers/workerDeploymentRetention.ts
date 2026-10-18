import {
  lockQueueAdmission,
  queueAdmissionKey,
  type QueueAdmission,
} from './workflowQueueAdmission';
/** No-clear custody holds for positively observed, still-serving route mismatches. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { WorkerDeploymentJob, WorkerDeploymentPreparation } from './workerDeploymentQueue';

type DB = Pick<Prisma.TransactionClient, 'toolSideEffect' | 'agentQueuePointer'>;
export interface RouteMismatchRecord {
  id: string;
  instanceId: string;
  configSHA256: string;
  managedJobId: string;
  routeEvidence: {
    machineId: string;
    instanceId: string;
    configSHA256: string;
    pid: number;
    started: number;
    namespace: string;
    expectedQueue: string;
    actualQueue: string;
    buildId: string;
    surfaceHash: string;
    attempt: string;
    identity: string;
    autoscalerActuate: string;
  };
}
const holdKey = (app: string, id: string) => `deployment:worker-route-retention:${app}:${id}`;
const reservationKey = (app: string, id: string) => `deployment:worker-machine:${app}:${id}`;
const fail = (): never => {
  throw new Error('Managed route mismatch retention proof is invalid');
};
const sameIDs = (a: unknown, b: string[]) =>
  Array.isArray(a) &&
  a.length === b.length &&
  new Set(a).size === a.length &&
  a.every((id) => typeof id === 'string' && b.includes(id));
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export async function requireWorkerMachineNotRetained(
  tx: DB,
  app: string,
  id: string
): Promise<void> {
  if (await tx.toolSideEffect.findUnique({ where: { operationKey: holdKey(app, id) } }))
    throw new Error(`Machine ${id} is retained under an unresolved route mismatch hold`);
}
export function routeMismatchRecords(
  evidence: Record<string, unknown> | undefined
): RouteMismatchRecord[] {
  const value = evidence?.retainedRouteMismatchRecords;
  if (value === undefined) return [];
  if (!Array.isArray(value) || (value.length !== 0 && value.length !== 8)) return fail();
  return value as unknown as RouteMismatchRecord[];
}
async function validatePrior(tx: DB, job: WorkerDeploymentJob, plan: WorkerDeploymentPreparation) {
  const held = routeMismatchRecords(plan.evidence);
  if (!held.length) return held;
  const previous = plan.evidence?.previousRecords as unknown as RouteMismatchRecord[];
  if (!Array.isArray(previous)) return fail();
  const managed = previous.filter((r) => r.managedJobId);
  if (
    !sameIDs(
      held.map((r) => r?.id),
      managed.map((r) => r.id)
    ) ||
    managed.length !== 8 ||
    held.some((r) => job.candidateMachineIds.includes(r.id))
  )
    return fail();
  const originalID = held[0]?.managedJobId;
  if (!nonempty(originalID) || held.some((r) => r.managedJobId !== originalID)) return fail();
  const row = await tx.toolSideEffect.findUnique({
    where: { operationKey: `deployment:worker-job:${originalID}` },
  });
  const original = row?.request as unknown as WorkerDeploymentJob;
  if (
    row?.operationType !== 'WORKER_DEPLOYMENT_JOB' ||
    original?.stage !== 'SUCCEEDED' ||
    original.jobId !== originalID ||
    original.identity?.app !== job.identity.app ||
    original.identity.surfaceHash !== plan.priorPointer?.surfaceHash ||
    plan.priorPointer?.taskQueue !==
      `navi-agent-tasks-pool-${createHash('sha256').update(originalID).digest('hex').slice(0, 12)}@${original.identity.surfaceHash}` ||
    !sameIDs(
      original.candidateMachineIds,
      held.map((r) => r.id)
    )
  )
    return fail();
  if (
    new Set(held.map((r) => r.routeEvidence?.namespace)).size !== 1 ||
    new Set(held.map((r) => r.routeEvidence?.actualQueue)).size !== 1 ||
    new Set(held.map((r) => r.routeEvidence?.identity)).size !== 8
  )
    return fail();
  for (const r of held) {
    const prior = managed.find((x) => x.id === r.id);
    const e = r.routeEvidence;
    if (
      !prior ||
      prior.managedJobId !== r.managedJobId ||
      prior.instanceId !== r.instanceId ||
      prior.configSHA256 !== r.configSHA256 ||
      !nonempty(r.instanceId) ||
      !/^[a-f0-9]{64}$/.test(r.configSHA256) ||
      !e ||
      e.machineId !== r.id ||
      e.instanceId !== r.instanceId ||
      e.configSHA256 !== r.configSHA256 ||
      !Number.isInteger(e.pid) ||
      e.pid <= 0 ||
      !Number.isFinite(e.started) ||
      e.started <= 0 ||
      !nonempty(e.namespace) ||
      e.namespace !== process.env.TEMPORAL_NAMESPACE ||
      !nonempty(e.identity) ||
      !e.identity.startsWith(`${e.pid}@`) ||
      e.identity.length <= String(e.pid).length + 1 ||
      !nonempty(e.actualQueue) ||
      e.expectedQueue !== plan.priorPointer?.taskQueue ||
      e.actualQueue === e.expectedQueue ||
      !e.actualQueue.endsWith(`@${e.surfaceHash}`) ||
      e.actualQueue.length <= e.surfaceHash.length + 1 ||
      e.buildId !== original.identity.buildId ||
      e.surfaceHash !== original.identity.surfaceHash ||
      e.attempt !== original.identity.attempt ||
      e.autoscalerActuate !== '0'
    )
      return fail();
    const reservation = await tx.toolSideEffect.findUnique({
      where: { operationKey: reservationKey(job.identity.app, r.id) },
    });
    if (
      reservation?.operationType !== 'WORKER_DEPLOYMENT_RESERVATION' ||
      reservation.status !== 'ACTIVE' ||
      (reservation.request as { jobId?: string } | null)?.jobId !== originalID ||
      !isDeepStrictEqual(
        (reservation.request as { identity?: unknown }).identity,
        original.identity
      ) ||
      (reservation.request as { machineId?: string }).machineId !== r.id
    )
      return fail();
  }
  return held;
}
export async function installWorkerRouteRetention(
  tx: DB,
  job: WorkerDeploymentJob,
  plan: WorkerDeploymentPreparation
): Promise<void> {
  const held = await validatePrior(tx, job, {
    ...plan,
    candidateMachineIds: plan.candidateMachineIds,
  });
  if (held.some((r) => plan.candidateMachineIds.includes(r.id))) return fail();
  if (held.length) {
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    if (pointer?.updatedBy !== held[0].managedJobId) return fail();
  }
  for (const record of held) {
    const operationKey = holdKey(job.identity.app, record.id);
    if (await tx.toolSideEffect.findUnique({ where: { operationKey } }))
      throw new Error('Machine already has an immutable retention hold');
    await tx.toolSideEffect.create({
      data: {
        operationKey,
        operationType: 'WORKER_DEPLOYMENT_RETENTION',
        externalId: job.identity.app,
        status: 'HELD',
        request: {
          version: 1,
          retainedByJobId: job.jobId,
          record,
        } as unknown as Prisma.InputJsonObject,
      },
    });
  }
}
export async function validateWorkerRouteRetention(tx: DB, job: WorkerDeploymentJob) {
  const held = await validatePrior(tx, job, {
    ...job,
    evidence: job.evidence.PREPARING as WorkerDeploymentPreparation['evidence'],
  });
  if (!held.length) return fail();
  for (const record of held) {
    const row = await tx.toolSideEffect.findUnique({
      where: { operationKey: holdKey(job.identity.app, record.id) },
    });
    if (
      row?.operationType !== 'WORKER_DEPLOYMENT_RETENTION' ||
      row.status !== 'HELD' ||
      !isDeepStrictEqual(row.request, { version: 1, retainedByJobId: job.jobId, record })
    )
      return fail();
  }
  return {
    machineIds: held.map((r) => r.id),
    records: held,
    unresolved: held.length,
    actualQueues: [...new Set(held.map((r) => r.routeEvidence.actualQueue))],
    retirementComplete: false as const,
  };
}
export async function requireRetainedCompletion(
  tx: DB,
  job: WorkerDeploymentJob,
  evidence: Record<string, Prisma.JsonValue>
) {
  const report = await validateWorkerRouteRetention(tx, job);
  const previous = job.evidence.PREPARING as {
    previousRecords: Array<{ id: string; managedJobId?: string }>;
  };
  const legacy = previous.previousRecords.filter((r) => !r.managedJobId).map((r) => r.id);
  if (
    !sameIDs(evidence.retainedRouteMismatchMachineIds, report.machineIds) ||
    !sameIDs(evidence.activeMachineIds, job.candidateMachineIds) ||
    !sameIDs(evidence.retainedLegacyMachineIds, legacy) ||
    !Array.isArray(evidence.retiredMachines) ||
    evidence.retiredMachines.length
  )
    return fail();
  return report;
}

export async function requireRetainedDisposition(
  tx: DB,
  job: WorkerDeploymentJob,
  evidence: Record<string, Prisma.JsonValue>
) {
  const held = routeMismatchRecords(job.evidence.PREPARING as Record<string, unknown> | undefined);
  if (evidence.priorDisposition === 'RETAINED_ROUTE_MISMATCH')
    return requireRetainedCompletion(tx, job, evidence);
  if (evidence.priorDisposition === 'RETIRED' && held.length)
    throw new Error('Retained mismatch bank requires explicit unresolved disposition');
}

/** Caller owns global deployment -> app -> queue-admission locks in that order. */
export async function fenceEmptyRetainedSource(
  tx: DB,
  job: WorkerDeploymentJob,
  current: { taskQueue: string; surfaceHash: string; updatedBy: string | null },
  targetQueue: string
): Promise<void> {
  const held = await validateWorkerRouteRetention(tx, job);
  const originalID = held.records[0].managedJobId;
  const source = job.priorPointer;
  if (
    !source ||
    (current.taskQueue !== source.taskQueue && current.taskQueue !== targetQueue) ||
    (current.taskQueue === source.taskQueue &&
      (current.updatedBy !== originalID || current.surfaceHash !== source.surfaceHash)) ||
    (current.taskQueue === targetQueue && current.updatedBy !== job.jobId)
  )
    return fail();
  const row = await tx.toolSideEffect.findUnique({
    where: { operationKey: `agent-queue-admission:${source.taskQueue}` },
  });
  const gate = row?.request as unknown as import('./workflowQueueAdmission').QueueAdmission;
  const original = await tx.toolSideEffect.findUnique({
    where: { operationKey: `deployment:worker-job:${originalID}` },
  });
  const priorJob = original?.request as unknown as WorkerDeploymentJob;
  if (
    row?.operationType !== 'AGENT_QUEUE_ADMISSION' ||
    row.status !== gate?.phase ||
    gate?.version !== 1 ||
    gate.queue !== source.taskQueue ||
    !gate.incarnation ||
    gate.surfaceHash !== source.surfaceHash ||
    gate.legacyCoverage !== 'QUALIFIED' ||
    gate.legacyCertificate?.unresolved !== 0 ||
    gate.legacyCertificate?.cohortManifest !== `fresh:${originalID}` ||
    gate.legacyCertificate?.producerTransition !==
      `immutable-start-and-native-continuation-v1:${priorJob.identity.sourceCommit}` ||
    !['OPEN', 'RETIRING', 'RETIRED'].includes(gate.phase) ||
    (gate.phase !== 'OPEN' && gate.owner !== job.jobId) ||
    (current.taskQueue === targetQueue && gate.phase === 'OPEN')
  )
    throw new Error('Retained mismatch declared source admission is unqualified or foreign');
  const member = await tx.toolSideEffect.findFirst({
    where: {
      operationType: { in: ['AGENT_QUEUE_START', 'AGENT_QUEUE_CONTINUATION'] },
      request: { path: ['queue'], equals: source.taskQueue },
    },
  });
  if (member)
    throw new Error('Declared source queue has producer membership; cannot move its serving bank');
  if (gate.phase === 'OPEN')
    await tx.toolSideEffect.update({
      where: { id: row!.id },
      data: {
        status: 'RETIRING',
        request: {
          ...gate,
          phase: 'RETIRING',
          owner: job.jobId,
        } as unknown as Prisma.InputJsonObject,
      },
    });
}

export async function requireRetainedPreparation(tx: DB, job: WorkerDeploymentJob) {
  if (routeMismatchRecords(job.evidence.PREPARING as Record<string, unknown> | undefined).length)
    await validateWorkerRouteRetention(tx, job);
}

export const WORKER_PRIOR_DISPOSITIONS = ['RETIRED', 'RETAINED_LEGACY', 'RETAINED_ROUTE_MISMATCH'];

export async function requireRetiredQueue(
  tx: Prisma.TransactionClient,
  job: WorkerDeploymentJob,
  overrideQueue?: string
): Promise<void> {
  if (!overrideQueue && !job.priorPointer)
    throw new Error('Source queue retirement certificate required');
  await lockQueueAdmission(tx);
  const queue = overrideQueue ?? job.priorPointer!.taskQueue;
  const row = await tx.toolSideEffect.findUnique({
    where: { operationKey: queueAdmissionKey(queue) },
  });
  const gate = row?.request as unknown as QueueAdmission | undefined;
  if (
    row?.operationType !== 'AGENT_QUEUE_ADMISSION' ||
    row?.status !== 'RETIRED' ||
    gate?.version !== 1 ||
    gate.queue !== queue ||
    gate.owner !== job.jobId ||
    !gate.incarnation ||
    gate?.phase !== 'RETIRED' ||
    gate.legacyCoverage !== 'QUALIFIED' ||
    !gate.legacyCertificate?.producerTransition ||
    !gate.legacyCertificate?.cohortManifest ||
    gate.legacyCertificate.unresolved !== 0
  )
    throw new Error('Source queue retirement is unqualified');
}
