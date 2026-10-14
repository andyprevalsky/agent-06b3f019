#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  acquireWorkflowDeploymentLease,
  WORKFLOW_DEPLOYMENT_LEASE_KEY,
} from '../../providers/workflowDeploymentLease';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow deployment lease unit tests');

async function clearLease(): Promise<void> {
  await prisma.toolSideEffect.deleteMany({
    where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
  });
}

async function main(): Promise<void> {
  await clearLease();

  await test('concurrent deployment is rejected until exact owner releases', async () => {
    const first = await acquireWorkflowDeploymentLease({
      leaseMs: 5_000,
      heartbeatMs: 500,
    });
    try {
      await first.assertOwned();
      await assert.rejects(
        acquireWorkflowDeploymentLease({ leaseMs: 5_000, heartbeatMs: 500 }),
        /another Temporal workflow deployment/i
      );
    } finally {
      await first.release();
    }
    const next = await acquireWorkflowDeploymentLease({
      leaseMs: 5_000,
      heartbeatMs: 500,
    });
    await next.assertOwned();
    await next.release();
  });

  await test('crashed stale owner can be reclaimed without its release', async () => {
    const stale = await acquireWorkflowDeploymentLease({
      leaseMs: 1_000,
      heartbeatMs: 900,
    });
    await prisma.toolSideEffect.update({
      where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
      data: { updatedAt: new Date(Date.now() - 2_000) },
    });
    const replacement = await acquireWorkflowDeploymentLease({
      leaseMs: 1_000,
      heartbeatMs: 900,
    });
    try {
      await replacement.assertOwned();
      await assert.rejects(stale.assertOwned(), /lost.*lease/i);
      await stale.release();
      await replacement.assertOwned();
    } finally {
      await replacement.release();
    }
  });

  await test('custom source leases renew and release only their own key and type', async () => {
    const firstKey = `test:browser-handoff:${randomUUID()}`;
    const secondKey = `test:browser-handoff:${randomUUID()}`;
    const first = await acquireWorkflowDeploymentLease({
      operationKey: firstKey,
      operationType: 'BROWSER_PROFILE_HANDOFF_LEASE',
      leaseMs: 1_000,
      heartbeatMs: 100,
    });
    const second = await acquireWorkflowDeploymentLease({
      operationKey: secondKey,
      operationType: 'BROWSER_PROFILE_HANDOFF_LEASE',
      leaseMs: 1_000,
      heartbeatMs: 100,
    });
    try {
      const before = await prisma.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: firstKey },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const renewed = await prisma.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: firstKey },
      });
      assert(renewed.updatedAt > before.updatedAt, 'custom lease heartbeat did not renew');
      assert.equal(renewed.externalId, first.ownerId);
      assert.equal(renewed.operationType, 'BROWSER_PROFILE_HANDOFF_LEASE');
      await first.assertOwned();
      await first.release();
      await second.assertOwned();
      const released = await prisma.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: firstKey },
      });
      assert.equal(released.status, 'RELEASED');
    } finally {
      await first.release();
      await second.release();
      await prisma.toolSideEffect.deleteMany({
        where: { operationKey: { in: [firstKey, secondKey] } },
      });
    }
  });

  await finish();
  await clearLease();
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await clearLease();
    await prisma.$disconnect();
  });
