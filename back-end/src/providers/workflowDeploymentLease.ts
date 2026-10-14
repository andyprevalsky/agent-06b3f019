import { randomUUID } from 'node:crypto';
import { prisma } from './database';

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
  if (leaseMs < 1_000 || heartbeatMs < 100 || heartbeatMs >= leaseMs) {
    throw new Error('Workflow deployment lease timings are invalid');
  }
  const ownerId = randomUUID();
  const acquired = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operationKey}))`;
    const cutoff = new Date(Date.now() - leaseMs);
    const existing = await tx.toolSideEffect.findUnique({
      where: { operationKey },
      select: { status: true, externalId: true, updatedAt: true },
    });
    if (existing?.status === 'STARTED' && existing.updatedAt >= cutoff) return false;
    await tx.toolSideEffect.upsert({
      where: { operationKey },
      create: {
        operationKey,
        operationType,
        status: 'STARTED',
        externalId: ownerId,
        request: { leaseMs },
      },
      update: {
        operationType,
        status: 'STARTED',
        externalId: ownerId,
        request: { leaseMs },
        response: undefined,
        error: null,
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
    const renewed = await prisma.toolSideEffect.updateMany({
      where: {
        operationKey,
        operationType,
        status: 'STARTED',
        externalId: ownerId,
      },
      data: { request: { leaseMs, renewedAt: new Date().toISOString() } },
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
