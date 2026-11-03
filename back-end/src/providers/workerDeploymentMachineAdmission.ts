/** Read-only native-effect admission, sharing durable controller and per-ID custody. */
import { runTransactionWithRetry } from './database';
import {
  assertWorkerDeploymentOwned,
  requireWorkerDeploymentLease,
  readWorkerDeployment,
  type WorkerDeploymentJob,
} from './workerDeploymentQueue';
import {
  requireWorkerMachineNotRetained,
  validateWorkerRouteRetention,
} from './workerDeploymentRetention';
import type { Prisma } from '@prisma/client';

async function requireController(
  tx: Prisma.TransactionClient,
  job: WorkerDeploymentJob,
  ownerId: string
) {
  await requireWorkerDeploymentLease(tx, ownerId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'deployment:worker-queue:' + job.identity.app}))`;
  const current = await tx.toolSideEffect.findUnique({
    where: { operationKey: `deployment:worker-job:${job.jobId}` },
  });
  const saved = current?.request as unknown as WorkerDeploymentJob;
  const head = await tx.toolSideEffect.findFirst({
    where: {
      operationType: 'WORKER_DEPLOYMENT_JOB',
      externalId: job.identity.app,
      status: { notIn: ['SUCCEEDED', 'ABORTED'] },
    },
    orderBy: [{ createdAt: 'asc' }, { operationKey: 'asc' }],
  });
  if (
    !saved ||
    saved.ownerId !== ownerId ||
    ['SUCCEEDED', 'ABORTED'].includes(saved.stage) ||
    (head?.request as { jobId?: string } | null)?.jobId !== job.jobId
  )
    throw new Error('FIFO terminal or controller owner no longer owns native admission');
  return saved;
}
export async function assertWorkerDeploymentMachineMutable(
  jobId: string,
  machineId: string,
  ownerId: string
) {
  const job = await assertWorkerDeploymentOwned(jobId, ownerId);
  return runTransactionWithRetry(async (tx) => {
    const current = await requireController(tx, job, ownerId);
    await requireWorkerMachineNotRetained(tx, current.identity.app, machineId);
    const previous =
      (
        current.evidence.PREPARING as {
          previousRecords?: Array<{ id: string; managedJobId?: string }>;
        }
      )?.previousRecords ?? [];
    const prior = previous.find((r) => r.id === machineId);
    const expected = current.candidateMachineIds.includes(machineId) ? jobId : prior?.managedJobId;
    const row = await tx.toolSideEffect.findUnique({
      where: { operationKey: `deployment:worker-machine:${current.identity.app}:${machineId}` },
    });
    if (
      !expected ||
      row?.operationType !== 'WORKER_DEPLOYMENT_RESERVATION' ||
      !['RESERVED', 'ACTIVE'].includes(row.status) ||
      (row.request as { jobId?: string })?.jobId !== expected
    )
      throw new Error('Machine is outside the exact owned deployment bank');
    return current;
  });
}
export async function readWorkerDeploymentRetainedRouteMismatch(jobId: string) {
  const job = await readWorkerDeployment(jobId);
  return runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'deployment:worker-queue:' + job.identity.app}))`;
    const report = await validateWorkerRouteRetention(tx, job);
    const row = await tx.toolSideEffect.findUnique({
      where: { operationKey: `agent-queue-admission:${job.priorPointer?.taskQueue}` },
    });
    const gate = row?.request as unknown as import('./workflowQueueAdmission').QueueAdmission;
    const original = report.records[0];
    const declaredQueueRetired =
      row?.operationType === 'AGENT_QUEUE_ADMISSION' &&
      row.status === 'RETIRED' &&
      gate?.phase === 'RETIRED' &&
      gate.version === 1 &&
      gate.queue === job.priorPointer?.taskQueue &&
      gate.owner === job.jobId &&
      gate.surfaceHash === job.priorPointer?.surfaceHash &&
      Boolean(gate.incarnation) &&
      gate.legacyCoverage === 'QUALIFIED' &&
      gate.legacyCertificate?.unresolved === 0 &&
      gate.legacyCertificate?.cohortManifest === `fresh:${original.managedJobId}` &&
      gate.legacyCertificate?.producerTransition ===
        `immutable-start-and-native-continuation-v1:${original.routeEvidence.buildId}`;
    return { ...report, declaredQueue: job.priorPointer?.taskQueue, declaredQueueRetired };
  });
}
