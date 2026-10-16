import { randomUUID } from 'node:crypto';
import { prisma, runTransactionWithRetry } from './database';

export const WORKFLOW_DEPLOYMENT_LEASE_KEY = 'deployment:temporal-workflow-cutover';
const LEASE_OPERATION_TYPE = 'TEMPORAL_WORKFLOW_DEPLOYMENT_LEASE';
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

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
      if (existing.updatedAt.getTime() + currentDuration > databaseTime.getTime()) return false;
    }
    await tx.toolSideEffect.upsert({
      where: { operationKey },
      create: {
        operationKey,
        operationType,
        status: 'STARTED',
        externalId: ownerId,
        request: { leaseMs },
        updatedAt: databaseTime,
      },
      update: {
        operationType,
        status: 'STARTED',
        externalId: ownerId,
        request: { leaseMs },
        response: undefined,
        error: null,
        updatedAt: databaseTime,
      },
    });
    return true;
  });
  if (!acquired) {
    throw new Error(
      operationKey === WORKFLOW_DEPLOYMENT_LEASE_KEY
        ? 'Another Temporal workflow deployment currently owns the production cutover'
        : `Another operation currently owns lease ${operationKey}`
    );
  }

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
          request: { leaseMs, renewedAt: databaseTime.toISOString() },
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
