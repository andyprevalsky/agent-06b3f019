#!/usr/bin/env tsx

import assert from 'node:assert';
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
