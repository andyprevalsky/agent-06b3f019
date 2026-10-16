import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { nonLocalDatabaseReason } from '../utils/localDatabaseUrl';
import {
  acquireWorkflowDeploymentLease,
  type WorkflowDeploymentLease,
} from './workflowDeploymentLease';
import { createWorkerProcessTransport } from './workerProcessTransport';
import {
  reconcileWorkerProcesses,
  validateWorkerProcessPlan,
  workerPlanIdentity,
  requireEightWorkerProcesses,
  type HostProcessObservation,
  type WorkerProcessPlan,
  type WorkerProcessTransport,
} from './workerProcessDeployment';

export const WORKER_PROCESS_DESIRED_KEY = 'deployment:existing-agent-worker-processes';
const OPERATION_TYPE = 'EXISTING_WORKER_PROCESS_DEPLOYMENT';
interface DesiredWorkerProcesses {
  version: 1;
  identity: string;
  plan: WorkerProcessPlan;
}
export interface WorkerProcessRepository {
  read(): Promise<DesiredWorkerProcesses | undefined>;
  record(identity: string, rows: HostProcessObservation[]): Promise<boolean>;
}
function recoveryRepository(publishBackendProof = false): WorkerProcessRepository {
  return {
    async read() {
      const row = await prisma.toolSideEffect.findUnique({
        where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
      });
      if (!row) return undefined;
      if (row.operationType !== OPERATION_TYPE || row.status !== 'ACTIVE')
        throw new Error('Existing-process desired state is not active');
      return row.request as unknown as DesiredWorkerProcesses;
    },
    async record(identity, rows) {
      return runTransactionWithRetry(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${WORKER_PROCESS_DESIRED_KEY}))`;
        const current = await tx.toolSideEffect.findUnique({
          where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
        });
        const request = current?.request as unknown as DesiredWorkerProcesses | undefined;
        if (
          current?.operationType !== OPERATION_TYPE ||
          current.status !== 'ACTIVE' ||
          request?.identity !== identity
        )
          return false;
        const prior = current.response as { backendRecovery?: Prisma.InputJsonValue } | null;
        const observation = {
          observedAt: new Date().toISOString(),
          identity,
          hosts: rows as unknown as Prisma.InputJsonArray,
          instanceId: process.env.RENDER_INSTANCE_ID ?? null,
          backendSource: process.env.RENDER_GIT_COMMIT ?? null,
          serviceId: process.env.RENDER_SERVICE_ID ?? null,
        };
        await tx.toolSideEffect.update({
          where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
          data: {
            response: {
              ...observation,
              ...(publishBackendProof
                ? { backendRecovery: observation }
                : prior?.backendRecovery
                  ? { backendRecovery: prior.backendRecovery }
                  : {}),
            },
          },
        });
        return true;
      });
    },
  };
}
const repository = recoveryRepository();

export function isBackendWorkerRecoveryOwner(
  environment: NodeJS.ProcessEnv,
  plan?: WorkerProcessPlan
): boolean {
  if (
    environment.RENDER !== 'true' ||
    environment.NODE_ENV !== 'production' ||
    !environment.RENDER_SERVICE_ID ||
    !environment.RENDER_INSTANCE_ID ||
    !/^[a-f0-9]{40}$/.test(environment.RENDER_GIT_COMMIT ?? '') ||
    !environment.DATABASE_URL ||
    nonLocalDatabaseReason(environment.DATABASE_URL) === null
  )
    return false;
  try {
    const database = new URL(environment.DATABASE_URL);
    return (
      ['postgres:', 'postgresql:'].includes(database.protocol) &&
      !!database.hostname &&
      (!plan ||
        (environment.RENDER_SERVICE_ID === plan.controlPlane.serviceId &&
          database.hostname === plan.controlPlane.databaseHost &&
          database.pathname.slice(1) === plan.controlPlane.databaseName &&
          environment.RENDER_GIT_COMMIT === plan.artifact.sourceCommit))
    );
  } catch {
    return false;
  }
}

export async function requireBackendWorkerRecovery(
  plan: WorkerProcessPlan,
  expectedPhase?: 'STANDBY' | 'RUNNING'
): Promise<void> {
  const row = await prisma.toolSideEffect.findUnique({
    where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
  });
  const response = row?.response as {
    backendRecovery?: {
      identity?: string;
      backendSource?: string;
      serviceId?: string;
      instanceId?: string;
      observedAt?: string;
      hosts?: HostProcessObservation[];
    };
  } | null;
  const proof = response?.backendRecovery;
  const at = Date.parse(proof?.observedAt ?? '');
  if (
    row?.operationType !== OPERATION_TYPE ||
    row.status !== 'ACTIVE' ||
    (row.request as unknown as DesiredWorkerProcesses)?.identity !== workerPlanIdentity(plan) ||
    !proof?.instanceId ||
    proof.serviceId !== plan.controlPlane.serviceId ||
    proof.identity !== workerPlanIdentity(plan) ||
    proof.backendSource !== plan.artifact.sourceCommit ||
    !Number.isFinite(at) ||
    Date.now() - at > 120_000 ||
    at > Date.now() ||
    !proof.hosts ||
    proof.hosts.length !== 8
  )
    throw new Error(
      'Exact source backend recovery owner has not positively observed all eight runtimes'
    );
  requireEightWorkerProcesses(
    plan,
    proof.hosts,
    expectedPhase ?? (proof.hosts.every((host) => host.phase === 'RUNNING') ? 'RUNNING' : 'STANDBY')
  );
}

/** Registration requires the normal global deployment lease; identical retries are safe. */
export async function registerExistingWorkerProcesses(
  plan: WorkerProcessPlan,
  lease: WorkflowDeploymentLease
): Promise<string> {
  validateWorkerProcessPlan(plan);
  const identity = workerPlanIdentity(plan);
  await lease.assertOwned();
  await runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${WORKER_PROCESS_DESIRED_KEY}))`;
    const row = await tx.toolSideEffect.findUnique({
      where: { operationKey: WORKER_PROCESS_DESIRED_KEY },
    });
    if (row) {
      const current = row.request as unknown as DesiredWorkerProcesses;
      if (
        row.operationType !== OPERATION_TYPE ||
        row.status !== 'ACTIVE' ||
        current.identity !== identity ||
        workerPlanIdentity(current.plan) !== identity
      )
        throw new Error('Another retained worker-process intent needs explicit reconciliation');
      return;
    }
    await tx.toolSideEffect.create({
      data: {
        operationKey: WORKER_PROCESS_DESIRED_KEY,
        operationType: OPERATION_TYPE,
        status: 'ACTIVE',
        externalId: plan.app,
        request: { version: 1, identity, plan } as unknown as Prisma.InputJsonObject,
      },
    });
  });
  await lease.assertOwned();
  return identity;
}

/** Durable after backend/VM restart. No activation, pointer, process-stop or Machine mutation. */
export async function recoverExistingWorkerProcesses(options: {
  transport: WorkerProcessTransport;
  key: string;
  expectedIdentity?: string;
  repository?: WorkerProcessRepository;
  lease?: WorkflowDeploymentLease;
  acquireLease?: () => Promise<WorkflowDeploymentLease>;
}): Promise<HostProcessObservation[]> {
  const store = options.repository ?? repository;
  const desired = await store.read();
  if (!desired) return [];
  if (desired.version !== 1 || workerPlanIdentity(desired.plan) !== desired.identity)
    throw new Error('Retained worker-process plan changed');
  if (options.expectedIdentity !== undefined && options.expectedIdentity !== desired.identity)
    throw new Error('Requested process plan differs from the retained deployment');
  validateWorkerProcessPlan(desired.plan);
  if (!options.key) throw new Error('Missing worker-process recovery authentication');
  const ownedHere = options.lease === undefined;
  const lease = options.lease ?? (await (options.acquireLease ?? acquireWorkflowDeploymentLease)());
  try {
    await lease.assertOwned();
    // Recheck after lease acquisition so an old backend instance cannot act on a replaced plan.
    const current = await store.read();
    if (
      !current ||
      current.identity !== desired.identity ||
      workerPlanIdentity(current.plan) !== desired.identity
    )
      throw new Error('Retained worker-process intent changed before recovery');
    const rows = await reconcileWorkerProcesses(
      desired.plan,
      options.transport,
      options.key,
      lease.assertOwned
    );
    await lease.assertOwned();
    if (!(await store.record(desired.identity, rows)))
      throw new Error('Recovery observation lost its exact intent custody');
    return rows;
  } finally {
    if (ownedHere) await lease.release();
  }
}

export async function recoverConfiguredWorkerProcesses(
  options: { transport?: WorkerProcessTransport } = {}
): Promise<HostProcessObservation[]> {
  // An ordinary backend deployment without an explicit retained intent has no Fly effects.
  if (!isBackendWorkerRecoveryOwner(process.env)) return [];
  const desired = await repository.read();
  if (!desired) return [];
  if (!isBackendWorkerRecoveryOwner(process.env, desired.plan))
    throw new Error('Backend service, database or source cannot own this process deployment');
  return recoverExistingWorkerProcesses({
    repository: recoveryRepository(true),
    transport: options.transport ?? createWorkerProcessTransport(process.env.FLY_API_TOKEN ?? ''),
    key: process.env.BACKEND_API_KEY ?? '',
  });
}
