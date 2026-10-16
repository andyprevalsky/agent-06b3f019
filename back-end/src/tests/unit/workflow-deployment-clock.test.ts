import assert from 'node:assert/strict';
import { prisma } from '../../providers/database';
import { acquireWorkflowDeploymentLease } from '../../providers/workflowDeploymentLease';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('deployment lease database clock');
const databaseTime = new Date('2026-10-16T12:00:00.000Z');
async function main() {
  const transaction = prisma.$transaction;
  const updateMany = prisma.toolSideEffect.updateMany;
  const clock = Date.now;
  let updatedAt = databaseTime;
  let existing = true;
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ now: databaseTime }],
    toolSideEffect: {
      findUnique: async () =>
        existing
          ? { status: 'STARTED', externalId: 'prior', updatedAt, request: { leaseMs: 5000 } }
          : null,
      upsert: async (args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        writes.push(args.create, args.update);
      },
      updateMany: async (args: {
        where: { updatedAt?: { gt: Date } };
        data: Record<string, unknown>;
      }) => {
        if (args.where.updatedAt && updatedAt <= args.where.updatedAt.gt) return { count: 0 };
        writes.push(args.data);
        return { count: 1 };
      },
    },
  };
  prisma.$transaction = (async (fn: (client: unknown) => unknown) => fn(tx)) as never;
  prisma.toolSideEffect.updateMany = tx.toolSideEffect.updateMany as never;
  try {
    await test('a fast controller clock cannot steal a fresh database lease', async () => {
      Date.now = () => databaseTime.getTime() + 3600000;
      updatedAt = databaseTime;
      existing = true;
      let lease: Awaited<ReturnType<typeof acquireWorkflowDeploymentLease>> | undefined;
      try {
        await assert.rejects(async () => {
          lease = await acquireWorkflowDeploymentLease({ leaseMs: 5000, heartbeatMs: 1000 });
        }, /Another Temporal workflow deployment/);
      } finally {
        await lease?.release();
      }
    });
    await test('a slow controller clock can recover a database-expired owner', async () => {
      Date.now = () => databaseTime.getTime() - 3600000;
      updatedAt = new Date(databaseTime.getTime() - 6000);
      existing = true;
      const lease = await acquireWorkflowDeploymentLease({ leaseMs: 5000, heartbeatMs: 1000 });
      await lease.release();
    });
    await test('a shorter requested lease cannot shorten the current owner lease', async () => {
      existing = true;
      updatedAt = new Date(databaseTime.getTime() - 2000);
      let lease: Awaited<ReturnType<typeof acquireWorkflowDeploymentLease>> | undefined;
      try {
        await assert.rejects(async () => {
          lease = await acquireWorkflowDeploymentLease({ leaseMs: 1000, heartbeatMs: 100 });
        }, /Another Temporal workflow deployment/);
      } finally {
        await lease?.release();
      }
    });
    await test('acquisition and renewal persist database time rather than host time', async () => {
      Date.now = () => databaseTime.getTime() + 3600000;
      existing = false;
      updatedAt = databaseTime;
      writes.length = 0;
      const lease = await acquireWorkflowDeploymentLease({ leaseMs: 5000, heartbeatMs: 1000 });
      try {
        await lease.assertOwned();
        assert.equal(writes.length, 3);
        for (const write of writes) assert.deepEqual(write.updatedAt, databaseTime);
      } finally {
        await lease.release();
      }
    });
    await test('an expired owner cannot resurrect its lease with a late heartbeat', async () => {
      existing = false;
      updatedAt = databaseTime;
      const lease = await acquireWorkflowDeploymentLease({ leaseMs: 5000, heartbeatMs: 1000 });
      updatedAt = new Date(databaseTime.getTime() - 6000);
      try {
        await assert.rejects(lease.assertOwned(), /lost its production cutover lease/);
      } finally {
        await lease.release();
      }
    });
  } finally {
    prisma.$transaction = transaction;
    prisma.toolSideEffect.updateMany = updateMany;
    Date.now = clock;
    await prisma.$disconnect();
  }
  finish();
}
void main();
