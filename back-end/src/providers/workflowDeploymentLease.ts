import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { prisma, runTransactionWithRetry } from './database';

export const WORKFLOW_DEPLOYMENT_LEASE_KEY = 'deployment:temporal-workflow-cutover';
const LEASE_OPERATION_TYPE = 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE';
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

/** Who holds a lease: recorded on acquire, kept on every renew, named on contention. */
export interface WorkflowDeploymentLeaseHolder {
  host: string;
  pid: number;
  purpose: string;
  acquiredAt?: string;
  githubRunId?: string;
  githubRunAttempt?: string;
  githubWorkflow?: string;
}

export function currentLeaseHolder(purpose?: string): WorkflowDeploymentLeaseHolder {
  const script = process.argv[1];
  const holder: WorkflowDeploymentLeaseHolder = {
    host: hostname(),
    pid: process.pid,
    purpose: purpose ?? (script ? basename(script) : basename(process.argv0)),
  };
  if (process.env.GITHUB_RUN_ID) holder.githubRunId = process.env.GITHUB_RUN_ID;
  if (process.env.GITHUB_RUN_ATTEMPT) holder.githubRunAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (process.env.GITHUB_WORKFLOW) holder.githubWorkflow = process.env.GITHUB_WORKFLOW;
  return holder;
}

export function describeLeaseHolder(
  ownerId: string | null,
  request: unknown,
  updatedAt?: Date
): string {
  const holder = (request as { holder?: Partial<WorkflowDeploymentLeaseHolder> } | null)?.holder;
  const parts = [`owner ${ownerId ?? 'unknown'}`];
  if (holder && typeof holder === 'object') {
    parts.push(`host ${holder.host ?? '?'}`, `pid ${holder.pid ?? '?'}`);
    parts.push(`purpose ${holder.purpose ?? '?'}`);
    if (holder.githubRunId) {
      parts.push(`GitHub run ${holder.githubRunId}/${holder.githubRunAttempt ?? '?'}`);
    }
    if (holder.githubWorkflow) parts.push(`workflow ${holder.githubWorkflow}`);
    if (holder.acquiredAt) parts.push(`acquired ${holder.acquiredAt}`);
  } else {
    parts.push('holder identity not recorded (pre-identity owner)');
  }
  if (updatedAt) parts.push(`last renewed ${updatedAt.toISOString()}`);
  return parts.join(', ');
}

export class WorkflowDeploymentLeaseBusyError extends Error {
  constructor(
    readonly operationKey: string,
    readonly holderDescription: string
  ) {
    super(
      `${
        operationKey === WORKFLOW_DEPLOYMENT_LEASE_KEY
          ? 'Another Temporal workflow deployment currently owns the production cutover'
          : `Another operation currently owns lease ${operationKey}`
      } (${holderDescription})`
    );
    this.name = 'WorkflowDeploymentLeaseBusyError';
  }
}

export interface WorkflowDeploymentLease {
  ownerId: string;
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
}

export async function acquireWorkflowDeploymentLease(
  options: {
    leaseMs?: number;
    heartbeatMs?: number;
    operationKey?: string;
    operationType?: string;
    /** Names this holder in the lease row; defaults to the entrypoint script name. */
    purpose?: string;
  } = {}
): Promise<WorkflowDeploymentLease> {
  const operationKey = options.operationKey ?? WORKFLOW_DEPLOYMENT_LEASE_KEY;
  const operationType = options.operationType ?? LEASE_OPERATION_TYPE;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (
    !Number.isFinite(leaseMs) ||
    !Number.isFinite(heartbeatMs) ||
    leaseMs < 1_000 ||
    heartbeatMs < 100 ||
    heartbeatMs >= leaseMs
  ) {
    throw new Error('Workflow deployment lease timings are invalid');
  }
  const ownerId = randomUUID();
  const holder = currentLeaseHolder(options.purpose);
  let busyHolder = '';
  const acquired = await runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operationKey}))`;
    const databaseTime = (
      await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    )[0].now;
    const existing = await tx.toolSideEffect.findUnique({
      where: { operationKey },
      select: { status: true, externalId: true, updatedAt: true, request: true },
    });
    if (existing?.status === 'STARTED') {
      const currentDuration = (existing.request as { leaseMs?: unknown } | null)?.leaseMs;
      if (
        typeof currentDuration !== 'number' ||
        !Number.isFinite(currentDuration) ||
        currentDuration <= 0
      )
        throw new Error('Current lease duration is unqualified');
      if (existing.updatedAt.getTime() + currentDuration > databaseTime.getTime()) {
        busyHolder = describeLeaseHolder(existing.externalId, existing.request, existing.updatedAt);
        return false;
      }
    }
    holder.acquiredAt = databaseTime.toISOString();
    await tx.toolSideEffect.upsert({
      where: { operationKey },
      create: {
        operationKey,
        operationType,
        status: 'STARTED',
        externalId: ownerId,
        request: { leaseMs, holder: { ...holder } },
        updatedAt: databaseTime,
      },
      update: {
        operationType,
        status: 'STARTED',
        externalId: ownerId,
        request: { leaseMs, holder: { ...holder } },
        response: undefined,
        error: null,
        updatedAt: databaseTime,
      },
    });
    return true;
  });
  if (!acquired) throw new WorkflowDeploymentLeaseBusyError(operationKey, busyHolder);

  let released = false;
  let leaseLost = false;
  const renew = async (): Promise<boolean> => {
    if (released || leaseLost) return false;
    const renewed = await runTransactionWithRetry(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operationKey}))`;
      const databaseTime = (
        await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      )[0].now;
      return tx.toolSideEffect.updateMany({
        where: {
          operationKey,
          operationType,
          status: 'STARTED',
          externalId: ownerId,
          updatedAt: { gt: new Date(databaseTime.getTime() - leaseMs) },
        },
        data: {
          request: { leaseMs, holder: { ...holder }, renewedAt: databaseTime.toISOString() },
          updatedAt: databaseTime,
        },
      });
    });
    if (renewed.count !== 1) leaseLost = true;
    return renewed.count === 1;
  };
  const heartbeat = setInterval(() => {
    void renew().catch(() => {
      leaseLost = true;
    });
  }, heartbeatMs);
  heartbeat.unref();

  return {
    ownerId,
    assertOwned: async () => {
      if (!(await renew())) {
        throw new Error(
          operationKey === WORKFLOW_DEPLOYMENT_LEASE_KEY
            ? 'Temporal workflow deployment lost its production cutover lease'
            : `Operation lost lease ${operationKey}`
        );
      }
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await prisma.toolSideEffect.updateMany({
        where: {
          operationKey,
          operationType,
          status: 'STARTED',
          externalId: ownerId,
        },
        data: {
          status: 'RELEASED',
          response: { releasedAt: new Date().toISOString() },
        },
      });
    },
  };
}
