#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Client } from '@temporalio/client';
import { prisma } from '../../providers/database';
import { cleanupSupersededWorkerActivationMarkersWithClient } from '../../providers/temporal';
import {
  WORKFLOW_DEPLOYMENT_LEASE_KEY,
  type WorkflowDeploymentLease,
} from '../../providers/workflowDeploymentLease';
import {
  beginValidationRun,
  endValidationRun,
  liveConcurrentValidationUserIds,
  observeSingleGeneration,
  runScopedTemporalClient,
  terminatorIdentity,
  VALIDATION_RUN_OPERATION_TYPE,
  validationRunLeaseKey,
  validationUserId,
} from '../../../scripts/workflow-migration-validation-run';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow migration validation run unit tests');

// Generous for a local insert under machine load; the pre-fix admission polled
// the global cutover lease for up to 600 s while another run held it.
const ADMISSION_BOUND_MS = 5_000;

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'blocked'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'blocked'>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fakeMarkerService(running: string[]) {
  const open = new Set(running);
  const terminations: Array<{ workflowId: string; identity: string }> = [];
  const workflowService = {
    listWorkflowExecutions: async () => ({
      executions: [...open].map((workflowId) => ({
        execution: { workflowId, runId: `run-${workflowId}` },
        type: { name: 'RoseWorkerDeploymentActivationMarker' },
        status: 1,
        historyLength: { toNumber: () => 1 },
        startTime: { nanos: 0 },
      })),
      nextPageToken: Buffer.alloc(0),
    }),
    terminateWorkflowExecution: async (request: {
      workflowExecution: { workflowId: string };
      identity: string;
    }) => {
      open.delete(request.workflowExecution.workflowId);
      terminations.push({
        workflowId: request.workflowExecution.workflowId,
        identity: request.identity,
      });
      return {};
    },
  };
  const connection = {
    workflowService,
    withDeadline: async <R>(_deadline: number | Date, fn: () => Promise<R>) => fn(),
  };
  return {
    client: new Client({ connection: connection as never, namespace: 'validation-unit' }),
    open,
    terminations,
  };
}

async function main(): Promise<void> {
  await test('concurrent validation runs are admitted without waiting on each other', async () => {
    const firstRun = randomUUID();
    const secondRun = randomUUID();
    const first = await beginValidationRun(firstRun);
    const pending = beginValidationRun(secondRun);
    let second: WorkflowDeploymentLease | 'blocked' = 'blocked';
    try {
      second = await settleWithin(pending, ADMISSION_BOUND_MS);
      if (second === 'blocked') {
        assert.fail(`second concurrent validation was not admitted within ${ADMISSION_BOUND_MS}ms`);
      }
      await first.assertOwned();
      await second.assertOwned();
      for (const runId of [firstRun, secondRun]) {
        const key = validationRunLeaseKey(runId);
        assert.notStrictEqual(key, WORKFLOW_DEPLOYMENT_LEASE_KEY);
        const row = await prisma.toolSideEffect.findUniqueOrThrow({
          where: { operationKey: key },
        });
        assert.strictEqual(row.operationType, VALIDATION_RUN_OPERATION_TYPE);
        assert.strictEqual(row.status, 'STARTED');
      }
    } finally {
      await endValidationRun(firstRun, first);
      await endValidationRun(secondRun, second === 'blocked' ? await pending : second);
    }
    assert.strictEqual(
      await prisma.toolSideEffect.count({
        where: { operationKey: { in: [firstRun, secondRun].map(validationRunLeaseKey) } },
      }),
      0
    );
  });

  await test('only live concurrent validation runs are excluded from fleet checks', async () => {
    const own = randomUUID();
    const live = randomUUID();
    const ended = randomUUID();
    const crashed = randomUUID();
    const neverAdmitted = randomUUID();
    const liveLease = await beginValidationRun(live, { leaseMs: 60_000, heartbeatMs: 30_000 });
    const endedLease = await beginValidationRun(ended);
    const crashedLease = await beginValidationRun(crashed, { leaseMs: 5_000, heartbeatMs: 4_000 });
    try {
      await endValidationRun(ended, endedLease);
      await crashedLease.release();
      await prisma.toolSideEffect.update({
        where: { operationKey: validationRunLeaseKey(crashed) },
        data: { status: 'STARTED', updatedAt: new Date(Date.now() - 60_000) },
      });
      const result = await liveConcurrentValidationUserIds(
        [
          validationUserId(own),
          validationUserId(live),
          validationUserId(ended),
          validationUserId(crashed),
          validationUserId(neverAdmitted),
          `real-user-${live}`,
        ],
        own
      );
      assert.deepStrictEqual(result, [validationUserId(live)]);
      assert.deepStrictEqual(await liveConcurrentValidationUserIds([], own), []);
    } finally {
      await endValidationRun(live, liveLease);
      await endValidationRun(crashed, crashedLease);
    }
  });

  await test('marker retirement is scoped to this run and attributed to its identity', async () => {
    const prefix = 'navi-worker-deployment-activation:' + 'a'.repeat(40);
    const deployMarker = `${prefix}:43685886937-1`;
    const otherRunMarker = `${prefix}:validation-current-other-1`;
    const current = `${prefix}:validation-current-own-1`;
    const old = `${prefix}:validation-old-own-1`;
    const temporal = fakeMarkerService([deployMarker, otherRunMarker, current, old]);
    const identity = validationUserId('own');

    const retired = await cleanupSupersededWorkerActivationMarkersWithClient(
      runScopedTemporalClient(temporal.client, [current, old], identity),
      current
    );

    assert.strictEqual(retired, 1);
    assert.deepStrictEqual(temporal.terminations, [{ workflowId: old, identity }]);
    assert.deepStrictEqual(
      [...temporal.open].sort(),
      [current, deployMarker, otherRunMarker].sort()
    );
  });

  await test('termination events name who retired a marker', () => {
    assert.strictEqual(
      terminatorIdentity([
        { workflowExecutionTerminatedEventAttributes: null },
        { workflowExecutionTerminatedEventAttributes: { identity: 'cutover@runner' } },
      ]),
      'cutover@runner'
    );
    assert.strictEqual(terminatorIdentity([{}]), null);
    assert.strictEqual(terminatorIdentity(undefined), null);
  });

  await test('cold observation re-runs only across a generation handoff', async () => {
    let runId = 'run-a';
    let calls = 0;
    const handedOff = await observeSingleGeneration(
      async () => runId,
      async () => {
        calls += 1;
        if (calls === 1) {
          runId = 'run-b';
          throw new Error('history grew inside the poll window');
        }
        return runId;
      }
    );
    assert.strictEqual(handedOff, 'run-b');
    assert.strictEqual(calls, 2);

    calls = 0;
    await assert.rejects(
      observeSingleGeneration(
        async () => 'run-a',
        async () => {
          calls += 1;
          throw new Error('history grew inside the poll window');
        }
      ),
      /history grew inside the poll window/
    );
    assert.strictEqual(calls, 1);

    calls = 0;
    let generation = 0;
    await assert.rejects(
      observeSingleGeneration(
        async () => `run-${generation}`,
        async () => {
          calls += 1;
          generation += 1;
          throw new Error('handed off every window');
        }
      ),
      /handed off every window/
    );
    assert.strictEqual(calls, 3);
  });

  finish();
}

void main();
