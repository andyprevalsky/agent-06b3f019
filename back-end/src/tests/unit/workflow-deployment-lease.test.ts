#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { prisma } from '../../providers/database';
import {
  acquireWorkflowDeploymentLease,
  WORKFLOW_DEPLOYMENT_LEASE_KEY,
  WorkflowDeploymentLeaseBusyError,
} from '../../providers/workflowDeploymentLease';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow deployment lease unit tests');

async function clearLease(): Promise<void> {
  await prisma.toolSideEffect.deleteMany({
    where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
  });
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(overrides);
  try {
    return await run();
  } finally {
    apply(previous);
  }
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

  await test('lease row records holder identity on acquire and renew, and contention names it', async () => {
    const holder = await withEnv(
      { GITHUB_RUN_ID: '424242', GITHUB_RUN_ATTEMPT: '3', GITHUB_WORKFLOW: undefined },
      () =>
        acquireWorkflowDeploymentLease({
          leaseMs: 5_000,
          heartbeatMs: 4_000,
          purpose: 'lease-identity-regression',
        })
    );
    try {
      const expected = {
        host: hostname(),
        pid: process.pid,
        purpose: 'lease-identity-regression',
        githubRunId: '424242',
        githubRunAttempt: '3',
      };
      const acquiredRow = await prisma.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
      });
      const acquiredRequest = acquiredRow.request as {
        leaseMs: number;
        holder: Record<string, unknown>;
      };
      assert.equal(acquiredRow.externalId, holder.ownerId);
      assert.equal(acquiredRequest.leaseMs, 5_000);
      assert.deepEqual(
        { ...acquiredRequest.holder, acquiredAt: undefined },
        {
          ...expected,
          acquiredAt: undefined,
        }
      );
      assert.equal(typeof acquiredRequest.holder.acquiredAt, 'string');

      await holder.assertOwned();
      const renewedRow = await prisma.toolSideEffect.findUniqueOrThrow({
        where: { operationKey: WORKFLOW_DEPLOYMENT_LEASE_KEY },
      });
      const renewedRequest = renewedRow.request as {
        leaseMs: number;
        renewedAt: string;
        holder: Record<string, unknown>;
      };
      assert.equal(renewedRequest.leaseMs, 5_000);
      assert.equal(typeof renewedRequest.renewedAt, 'string');
      assert.deepEqual(renewedRequest.holder, acquiredRequest.holder);

      const contention = await acquireWorkflowDeploymentLease({
        leaseMs: 5_000,
        heartbeatMs: 4_000,
      }).then(
        () => assert.fail('a second owner acquired a live lease'),
        (error: unknown) => error
      );
      assert(contention instanceof WorkflowDeploymentLeaseBusyError);
      assert.match(contention.message, /another Temporal workflow deployment/i);
      for (const fragment of [
        `owner ${holder.ownerId}`,
        `host ${hostname()}`,
        `pid ${process.pid}`,
        'purpose lease-identity-regression',
        'GitHub run 424242/3',
      ]) {
        assert(
          contention.message.includes(fragment),
          `missing "${fragment}": ${contention.message}`
        );
      }
    } finally {
      await holder.release();
    }
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
