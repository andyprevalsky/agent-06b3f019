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
  options: { leaseMs?: number; heartbeatMs?: number } = {}
): Promise<WorkflowDeploymentLease> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (leaseMs < 1_000 || heartbeatMs < 100 || heartbeatMs >= leaseMs) {
    throw new Error('Workflow deployment lease timings are invalid');
  }
  const ownerId = randomUUID();
  const acquired = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${WORKFLOW_DEPLOYMENT_LEASE_KEY}))`;
    const cutoff = new Date(Date.now() - leaseMs);
    const existing = await tx.toolSideEffect.findUnique({
      where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
      select: { status: true, externalId: true, updatedAt: true },
    });
    if (existing?.status === 'STARTED' && existing.updatedAt >= cutoff) return false;
    await tx.toolSideEffect.upsert({
      where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
      create: {
        operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY,
        operationType: LEASE_OPERATION_TYPE,
        status: 'STARTED',
        externalId: ownerId,
        request: { leaseMs },
      },
      update: {
        operationType: LEASE_OPERATION_TYPE,
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
    throw new Error('Another Temporal workflow deployment currently owns the production cutover');
  }

  let released = false;
  let leaseLost = false;
  const renew = async (): Promise<boolean> => {
    if (released || leaseLost) return false;
    const renewed = await prisma.toolSideEffect.updateMany({
      where: {
        operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY,
        operationType: LEASE_OPERATION_TYPE,
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
        throw new Error('Temporal workflow deployment lost its production cutover lease');
      }
    },
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await prisma.toolSideEffect.updateMany({
        where: {
          operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY,
          operationType: LEASE_OPERATION_TYPE,
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
