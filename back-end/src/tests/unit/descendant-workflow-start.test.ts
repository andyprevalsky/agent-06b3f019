#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma } from '../../providers/database';
import {
  claimDescendantWorkflowStart,
  drainPendingDescendantWorkflowStarts,
  executeDescendantWorkflowStart,
  reconcileStartedDescendantWorkflow,
  type DescendantWorkflowStartIdentity,
} from '../../providers/descendantWorkflowStart';
import { StaleParentWorkflowGenerationError } from '../../providers/workflowGeneration';
import { assertNoUnsafeOpenDescendantWorkflows } from '../../providers/workflowDeploymentMigration';
import { createAgentTransaction } from '../../domains/agents/repoMutations';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('descendant workflow start outbox unit tests');

interface Fixture {
  runId: string;
  rootId: string;
  rootWorkflowId: string;
  childId: string;
  identity: DescendantWorkflowStartIdentity;
}

async function createFixture(status: 'STARTING_UP' | 'COMPLETED' | 'FAILED' = 'STARTING_UP') {
  const runId = `descendant-start-${randomUUID()}`;
  const rootId = randomUUID();
  const childId = randomUUID();
  const rootWorkflowId = `root-workflow-${randomUUID()}`;
  await prisma.agent.create({
    data: {
      id: rootId,
      userId: runId,
      goal: 'root',
      status: 'ACTIVE',
      temporalWorkflowId: rootWorkflowId,
    },
  });
  await prisma.agent.create({
    data: {
      id: childId,
      userId: runId,
      goal: 'child',
      status,
      parentAgentId: rootId,
      parentWorkflowId: rootWorkflowId,
      temporalWorkflowId: childId,
      temporalWorkflowStartPending: true,
    },
  });
  return {
    runId,
    rootId,
    rootWorkflowId,
    childId,
    identity: { agentId: childId, parentAgentId: rootId, parentWorkflowId: rootWorkflowId },
  } satisfies Fixture;
}

async function cleanup(fixture: Fixture): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId: fixture.runId } });
}

const executionFor = (fixture: Fixture) => ({
  workflowId: fixture.childId,
  firstExecutionRunId: `run-${randomUUID()}`,
});

async function main(): Promise<void> {
  await test('current parent grants one bounded lease and concurrent retry observes it', async () => {
    const fixture = await createFixture();
    try {
      const first = await claimDescendantWorkflowStart(fixture.identity, 1_000, 10_000);
      const second = await claimDescendantWorkflowStart(fixture.identity, 1_001, 10_000);
      assert.deepStrictEqual(first, { outcome: 'claimed', deadlineAtMs: 11_000 });
      assert.deepStrictEqual(second, { outcome: 'leased', retryAfterMs: 9_999 });
    } finally {
      await cleanup(fixture);
    }
  });

  await test('accepted start durably stores exact chain and duplicate finalization is inert', async () => {
    const fixture = await createFixture();
    const execution = executionFor(fixture);
    let terminations = 0;
    try {
      await claimDescendantWorkflowStart(fixture.identity);
      const first = await reconcileStartedDescendantWorkflow(fixture.identity, execution, {
        captureInProgressTools: async () => [],
        terminate: async () => {
          terminations += 1;
        },
        finalizeInterruptedTools: async () => undefined,
      });
      const duplicate = await reconcileStartedDescendantWorkflow(fixture.identity, execution, {
        captureInProgressTools: async () => [],
        terminate: async () => {
          terminations += 1;
        },
        finalizeInterruptedTools: async () => undefined,
      });
      assert.strictEqual(first.outcome, 'accepted');
      assert.strictEqual(duplicate.outcome, 'accepted');
      assert.strictEqual(terminations, 0);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } });
      assert.strictEqual(stored.temporalFirstExecutionRunId, execution.firstExecutionRunId);
      assert.strictEqual(stored.temporalWorkflowStartPending, false);
    } finally {
      await cleanup(fixture);
    }
  });

  await test('seal after lease but before start terminates exact chain and fails child', async () => {
    const fixture = await createFixture();
    const execution = executionFor(fixture);
    const terminated: string[] = [];
    try {
      await claimDescendantWorkflowStart(fixture.identity);
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      const result = await reconcileStartedDescendantWorkflow(fixture.identity, execution, {
        captureInProgressTools: async () => [],
        terminate: async (ref) => {
          terminated.push(ref.firstExecutionRunId);
        },
        finalizeInterruptedTools: async () => undefined,
      });
      assert.strictEqual(result.outcome, 'stale');
      assert.deepStrictEqual(terminated, [execution.firstExecutionRunId]);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } });
      assert.strictEqual(stored.status, 'FAILED');
      assert.strictEqual(stored.statusMessage, 'new code version deployed, retry this tool');
      assert.strictEqual(stored.temporalWorkflowStartPending, false);
      assert.match(stored.temporalWorkflowId ?? '', /:deployment-sealed:/);
    } finally {
      await cleanup(fixture);
    }
  });

  await test('seal before claim rejects without calling Temporal start', async () => {
    const fixture = await createFixture();
    let starts = 0;
    try {
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      await assert.rejects(
        () =>
          executeDescendantWorkflowStart(fixture.identity, async () => {
            starts += 1;
            return executionFor(fixture);
          }),
        StaleParentWorkflowGenerationError
      );
      assert.strictEqual(starts, 0);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } });
      assert.strictEqual(stored.temporalWorkflowStartPending, true);
    } finally {
      await cleanup(fixture);
    }
  });

  for (const status of ['COMPLETED', 'FAILED'] as const) {
    await test(`${status} during an accepted start is quiesced before pending clears`, async () => {
      const fixture = await createFixture(status);
      const execution = executionFor(fixture);
      let terminated = false;
      try {
        await claimDescendantWorkflowStart(fixture.identity);
        const result = await reconcileStartedDescendantWorkflow(fixture.identity, execution, {
          captureInProgressTools: async () => [],
          terminate: async () => {
            terminated = true;
          },
          finalizeInterruptedTools: async () => undefined,
        });
        assert.strictEqual(result.outcome, 'terminal');
        assert.strictEqual(terminated, true);
        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } });
        assert.strictEqual(stored.status, status);
        assert.strictEqual(stored.temporalWorkflowStartPending, false);
      } finally {
        await cleanup(fixture);
      }
    });
  }

  await test('termination failure retains sealed pending state for safe retry', async () => {
    const fixture = await createFixture();
    const execution = executionFor(fixture);
    try {
      await claimDescendantWorkflowStart(fixture.identity);
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      await assert.rejects(
        () =>
          reconcileStartedDescendantWorkflow(fixture.identity, execution, {
            captureInProgressTools: async () => [],
            terminate: async () => {
              throw new Error('workflow was not terminated: permission failure');
            },
            finalizeInterruptedTools: async () => undefined,
          }),
        /permission failure/
      );
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } });
      assert.strictEqual(stored.temporalWorkflowStartPending, true);
      assert.strictEqual(stored.staleTemporalFirstExecutionRunId, execution.firstExecutionRunId);
      assert.match(stored.temporalWorkflowId ?? '', /:deployment-sealed:/);
    } finally {
      await cleanup(fixture);
    }
  });

  await test('tombstone wins ambiguous start only after child is durably sealed', async () => {
    const fixture = await createFixture();
    const tombstone = executionFor(fixture);
    const terminated: string[] = [];
    try {
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      const drained = await drainPendingDescendantWorkflowStarts(
        [fixture.rootId],
        {
          resolveExecution: async (workflowId) => {
            throw new WorkflowNotFoundError('missing', workflowId, undefined);
          },
          claimExecutionForTermination: async (workflowId) => {
            assert.strictEqual(workflowId, fixture.childId);
            const sealed = await prisma.agent.findUniqueOrThrow({
              where: { id: fixture.childId },
            });
            assert.match(sealed.temporalWorkflowId ?? '', /:deployment-sealed:/);
            assert.strictEqual(sealed.staleTemporalWorkflowId, fixture.childId);
            return tombstone;
          },
          terminate: async (execution) => {
            terminated.push(execution.firstExecutionRunId);
          },
          captureInProgressTools: async () => [],
          finalizeInterruptedTools: async () => undefined,
        },
        { timeoutMs: 1_000, pollIntervalMs: 1 }
      );
      assert.strictEqual(drained, 1);
      assert.deepStrictEqual(terminated, [tombstone.firstExecutionRunId]);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } });
      assert.strictEqual(stored.temporalWorkflowStartPending, false);
      assert.strictEqual(stored.status, 'FAILED');
    } finally {
      await cleanup(fixture);
    }
  });

  await test('agent start wins but lost response is resolved and terminated exactly', async () => {
    const fixture = await createFixture();
    const accepted = executionFor(fixture);
    const terminated: string[] = [];
    try {
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      await drainPendingDescendantWorkflowStarts(
        [fixture.rootId],
        {
          resolveExecution: async (workflowId) => {
            assert.strictEqual(workflowId, fixture.childId);
            return accepted;
          },
          claimExecutionForTermination: async () => {
            throw new Error('existing AgentWorkflow must win without a tombstone');
          },
          terminate: async (execution) => {
            terminated.push(execution.firstExecutionRunId);
          },
          captureInProgressTools: async () => [],
          finalizeInterruptedTools: async () => undefined,
        },
        { timeoutMs: 1_000, pollIntervalMs: 1 }
      );
      assert.deepStrictEqual(terminated, [accepted.firstExecutionRunId]);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } });
      assert.strictEqual(stored.temporalWorkflowStartPending, false);
      assert.strictEqual(stored.status, 'FAILED');
    } finally {
      await cleanup(fixture);
    }
  });

  await test('cleanup-presealed child still tombstones immutable child ID', async () => {
    const fixture = await createFixture('FAILED');
    const tombstone = executionFor(fixture);
    const sealedId = `${fixture.childId}:deployment-sealed:${randomUUID()}`;
    try {
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      await prisma.agent.update({
        where: { id: fixture.childId },
        data: {
          temporalWorkflowId: sealedId,
          staleTemporalWorkflowId: null,
          staleTemporalFirstExecutionRunId: null,
        },
      });
      await drainPendingDescendantWorkflowStarts(
        [fixture.rootId],
        {
          resolveExecution: async (workflowId) => {
            assert.strictEqual(workflowId, fixture.childId);
            throw new WorkflowNotFoundError('missing', workflowId, undefined);
          },
          claimExecutionForTermination: async (workflowId) => {
            assert.strictEqual(workflowId, fixture.childId);
            return tombstone;
          },
          terminate: async (execution) => {
            assert.strictEqual(execution.workflowId, fixture.childId);
          },
          captureInProgressTools: async () => [],
          finalizeInterruptedTools: async () => undefined,
        },
        { timeoutMs: 1_000, pollIntervalMs: 1 }
      );
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } });
      assert.strictEqual(stored.temporalWorkflowStartPending, false);
      assert.strictEqual(stored.status, 'FAILED');
    } finally {
      await cleanup(fixture);
    }
  });

  await test('termination success plus DB-finalize crash is safely retried', async () => {
    const fixture = await createFixture();
    const accepted = executionFor(fixture);
    let terminations = 0;
    let finalizations = 0;
    try {
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      const dependencies = {
        resolveExecution: async () => accepted,
        claimExecutionForTermination: async () => accepted,
        terminate: async () => {
          terminations += 1;
        },
        captureInProgressTools: async () => [],
        finalizeInterruptedTools: async () => {
          finalizations += 1;
          if (finalizations === 1) throw new Error('synthetic DB finalize crash');
        },
      };
      await assert.rejects(
        () =>
          drainPendingDescendantWorkflowStarts([fixture.rootId], dependencies, {
            timeoutMs: 1_000,
            pollIntervalMs: 1,
          }),
        /synthetic DB finalize crash/
      );
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } }))
          .temporalWorkflowStartPending,
        true
      );
      await drainPendingDescendantWorkflowStarts([fixture.rootId], dependencies, {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      });
      assert.strictEqual(terminations, 2);
      assert.strictEqual(finalizations, 2);
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } }))
          .temporalWorkflowStartPending,
        false
      );
    } finally {
      await cleanup(fixture);
    }
  });

  await test('nested pending grandchild and child are both quiesced', async () => {
    const fixture = await createFixture();
    const grandchildId = randomUUID();
    const terminated = new Set<string>();
    try {
      await prisma.agent.create({
        data: {
          id: grandchildId,
          userId: fixture.runId,
          goal: 'grandchild',
          parentAgentId: fixture.childId,
          parentWorkflowId: fixture.childId,
          depth: 2,
          status: 'STARTING_UP',
          temporalWorkflowId: grandchildId,
          temporalWorkflowStartPending: true,
        },
      });
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      await prisma.agent.update({
        where: { id: fixture.childId },
        data: {
          status: 'FAILED',
          temporalWorkflowId: `${fixture.childId}:deployment-sealed:${randomUUID()}`,
        },
      });
      await drainPendingDescendantWorkflowStarts(
        [fixture.rootId],
        {
          resolveExecution: async (workflowId) => ({
            workflowId,
            firstExecutionRunId: `run-${workflowId}`,
          }),
          claimExecutionForTermination: async (workflowId) => ({
            workflowId,
            firstExecutionRunId: `run-${workflowId}`,
          }),
          terminate: async (execution) => {
            terminated.add(execution.workflowId);
          },
          captureInProgressTools: async () => [],
          finalizeInterruptedTools: async () => undefined,
        },
        { timeoutMs: 1_000, pollIntervalMs: 1 }
      );
      assert.deepStrictEqual(terminated, new Set([fixture.childId, grandchildId]));
      const pending = await prisma.agent.count({
        where: { id: { in: [fixture.childId, grandchildId] }, temporalWorkflowStartPending: true },
      });
      assert.strictEqual(pending, 0);
    } finally {
      await cleanup(fixture);
    }
  });

  await test('current parent is never tombstoned by the deployment drain', async () => {
    const fixture = await createFixture();
    let clock = 0;
    let tombstones = 0;
    try {
      await assert.rejects(
        () =>
          drainPendingDescendantWorkflowStarts(
            [fixture.rootId],
            {
              resolveExecution: async () => {
                throw new Error('current child must not be probed');
              },
              claimExecutionForTermination: async () => {
                tombstones += 1;
                return executionFor(fixture);
              },
            },
            {
              timeoutMs: 10,
              pollIntervalMs: 5,
              now: () => clock,
              sleep: async (milliseconds) => {
                clock += milliseconds;
              },
            }
          ),
        /did not drain before activation/
      );
      assert.strictEqual(tombstones, 0);
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: fixture.childId } }))
          .temporalWorkflowStartPending,
        true
      );
    } finally {
      await cleanup(fixture);
    }
  });

  await test('active or FAILED pending lease blocks activation and reports exact row', async () => {
    const fixture = await createFixture('FAILED');
    let nowMs = 1_000;
    try {
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      await prisma.agent.update({
        where: { id: fixture.childId },
        data: { temporalWorkflowStartLeaseUntil: new Date(60_000) },
      });
      await assert.rejects(
        () =>
          drainPendingDescendantWorkflowStarts(
            [fixture.rootId],
            {
              resolveExecution: async () => {
                throw new Error('active lease must not probe Temporal');
              },
            },
            {
              timeoutMs: 10,
              pollIntervalMs: 5,
              now: () => nowMs,
              sleep: async (milliseconds) => {
                nowMs += milliseconds;
              },
            }
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('did not drain before activation') &&
          error.message.includes(fixture.childId)
      );
      await assert.rejects(
        () => assertNoUnsafeOpenDescendantWorkflows([fixture.rootId]),
        new RegExp(fixture.childId)
      );
    } finally {
      await cleanup(fixture);
    }
  });

  await test('scoped activation ignores descendants created under unrelated new roots', async () => {
    const fixture = await createFixture('COMPLETED');
    const unrelated = await createFixture();
    try {
      await prisma.agent.update({
        where: { id: fixture.childId },
        data: { temporalWorkflowStartPending: false },
      });
      await assertNoUnsafeOpenDescendantWorkflows([fixture.rootId]);
      await assert.rejects(
        () => assertNoUnsafeOpenDescendantWorkflows([unrelated.rootId]),
        new RegExp(unrelated.childId)
      );
    } finally {
      await cleanup(fixture);
      await cleanup(unrelated);
    }
  });

  await test('stale or terminal parent generation cannot create a descendant row', async () => {
    const fixture = await createFixture();
    try {
      await prisma.agent.update({
        where: { id: fixture.rootId },
        data: { temporalWorkflowId: `${fixture.rootId}:replacement` },
      });
      for (const terminal of [false, true]) {
        const newChildId = randomUUID();
        if (terminal) {
          await prisma.agent.update({
            where: { id: fixture.rootId },
            data: {
              temporalWorkflowId: fixture.rootWorkflowId,
              status: 'COMPLETED',
            },
          });
        }
        await assert.rejects(
          () =>
            createAgentTransaction({
              agentId: newChildId,
              userId: fixture.runId,
              parentAgentId: fixture.rootId,
              parentWorkflowId: fixture.rootWorkflowId,
              depth: 1,
              busId: fixture.rootId,
              goal: 'late child',
              model: 'rose-labs/rose-1-lite',
              reasoningMaxTokens: 256,
              source: 'WEB',
              tokenInPriceMicrodollars: null,
              tokenOutPriceMicrodollars: null,
              pauseState: false,
              responseSchema: undefined,
              proxyCountry: 'US',
              verifierType: 'FLOAT_LLM_JUDGE',
              temporalWorkflowId: newChildId,
            }),
          StaleParentWorkflowGenerationError
        );
        assert.strictEqual(await prisma.agent.count({ where: { id: newChildId } }), 0);
      }
    } finally {
      await cleanup(fixture);
    }
  });

  finish();
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
