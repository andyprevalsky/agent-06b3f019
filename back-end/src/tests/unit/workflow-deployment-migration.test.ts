#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { type AgentStatus } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma } from '../../providers/database';
import { preflightAgentWorkflowReplacement } from '../../domains/agents/agentRestartPreflight';
import {
  activateTemporalWorkerBuildWithClient,
  cleanupSupersededWorkerActivationMarkersWithClient,
  workerDeploymentActivationWorkflowId,
} from '../../providers/temporal';
import {
  assertNoUnsafeOpenDescendantWorkflows,
  migrateWorkflowCandidates,
  runWorkflowDeploymentCutover,
  snapshotOpenRootWorkflows,
  waitForWorkflowReplacementBootstrap,
  type WorkflowDeploymentCandidate,
} from '../../providers/workflowDeploymentMigration';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow deployment migration unit tests');

async function createAgent(
  runId: string,
  status: AgentStatus,
  options: { parentAgentId?: string; workflow?: boolean; verifier?: boolean } = {}
): Promise<string> {
  const id = randomUUID();
  const parent =
    options.parentAgentId === undefined
      ? null
      : await prisma.agent.findUniqueOrThrow({
          where: { id: options.parentAgentId },
          select: { temporalWorkflowId: true },
        });
  await prisma.agent.create({
    data: {
      id,
      userId: runId,
      goal: `deployment migration ${status}`,
      status,
      busId: options.parentAgentId ?? id,
      parentAgentId: options.parentAgentId,
      parentWorkflowId: parent?.temporalWorkflowId,
      temporalWorkflowId: options.workflow === false ? null : `workflow-${id}`,
      ...(options.verifier === false ? {} : { verifier: { create: {} } }),
    },
  });
  return id;
}

async function main(): Promise<void> {
  await test('snapshot freezes every open root so malformed roots block activation', async () => {
    const runId = `workflow-deployment-migration-${randomUUID()}`;
    const before = new Date();
    const active = await createAgent(runId, 'ACTIVE');
    const paused = await createAgent(runId, 'PAUSED');
    const costLimited = await createAgent(runId, 'COST_LIMIT_REACHED');
    const outOfCredits = await createAgent(runId, 'OUT_OF_CREDITS');
    const starting = await createAgent(runId, 'STARTING_UP');
    const child = await createAgent(runId, 'ACTIVE', { parentAgentId: active });
    const completed = await createAgent(runId, 'COMPLETED');
    const failed = await createAgent(runId, 'FAILED');
    const noWorkflow = await createAgent(runId, 'ACTIVE', { workflow: false });
    const noVerifier = await createAgent(runId, 'ACTIVE', { verifier: false });
    const deleted = await createAgent(runId, 'ACTIVE');
    await prisma.agent.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const cutoff = new Date(Date.now() + 100);
    const tooNew = await createAgent(runId, 'ACTIVE');
    await prisma.agent.update({
      where: { id: tooNew },
      data: { createdAt: new Date(cutoff.getTime() + 1_000) },
    });

    try {
      const candidates = await snapshotOpenRootWorkflows(cutoff);
      const ownCandidates = candidates.filter((candidate) =>
        [
          active,
          paused,
          costLimited,
          outOfCredits,
          starting,
          child,
          completed,
          failed,
          noWorkflow,
          noVerifier,
          deleted,
          tooNew,
        ].includes(candidate.agentId)
      );
      assert.deepStrictEqual(
        new Set(ownCandidates.map((candidate) => candidate.agentId)),
        new Set([active, paused, costLimited, outOfCredits, starting, noVerifier])
      );
      assert(before <= cutoff);
    } finally {
      await prisma.agent.deleteMany({ where: { userId: runId } });
    }
  });

  await test('bounded migration attempts every frozen candidate and records failures', async () => {
    const candidates: WorkflowDeploymentCandidate[] = Array.from({ length: 17 }, (_, index) => ({
      agentId: `agent-${index}`,
      workflowId: `workflow-${index}`,
    }));
    let active = 0;
    let peak = 0;
    const outcomes = await migrateWorkflowCandidates(
      candidates,
      async (candidate) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (candidate.agentId === 'agent-7') throw new Error('synthetic failure');
        return { ...candidate, outcome: candidate.agentId === 'agent-9' ? 'skipped' : 'migrated' };
      },
      4
    );

    assert(peak <= 4);
    assert.strictEqual(outcomes.length, candidates.length);
    assert.strictEqual(outcomes.filter((outcome) => outcome.outcome === 'failed').length, 1);
    assert.strictEqual(
      outcomes.find((outcome) => outcome.agentId === 'agent-7')?.error,
      'synthetic failure'
    );
    assert.strictEqual(
      outcomes.find((outcome) => outcome.agentId === 'agent-9')?.outcome,
      'skipped'
    );
  });

  await test('orphan descendant workflows block worker activation', async () => {
    const runId = `workflow-deployment-orphan-${randomUUID()}`;
    const parent = await createAgent(runId, 'ACTIVE');
    const child = await createAgent(runId, 'ACTIVE', { parentAgentId: parent });
    await prisma.agent.update({
      where: { id: parent },
      data: { status: 'COMPLETED', temporalWorkflowId: null },
    });
    try {
      await assert.rejects(assertNoUnsafeOpenDescendantWorkflows(), /open descendant workflow/);
      await assert.rejects(
        assertNoUnsafeOpenDescendantWorkflows([parent]),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('open descendant workflow') &&
          error.message.includes(child)
      );
      await prisma.agent.update({
        where: { id: child },
        data: { status: 'FAILED', temporalWorkflowStartPending: false },
      });
      try {
        await assertNoUnsafeOpenDescendantWorkflows([parent]);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          !error.message.includes(child),
          'the cleared descendant must not remain in the global orphan report'
        );
      }
    } finally {
      await prisma.agent.deleteMany({ where: { userId: runId } });
    }
  });

  await test('cutover seals every candidate before activation, then requires serial canary READY', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      agentId: `agent-${index}`,
      workflowId: `workflow-${index}`,
    }));
    const events: string[] = [];
    const prepared = new Set<string>();
    const result = await runWorkflowDeploymentCutover(
      candidates,
      {
        preflight: async () => ({ outcome: 'ready' }),
        prepare: async (candidate) => {
          events.push(`prepare:${candidate.agentId}`);
          prepared.add(candidate.agentId);
          return { outcome: 'prepared', prepared: candidate.agentId };
        },
        activate: async () => {
          assert.strictEqual(prepared.size, candidates.length);
          events.push('activate');
        },
        start: async (candidate) => {
          events.push(`start:${candidate.agentId}`);
          return { workflowId: `new-${candidate.agentId}` };
        },
        waitUntilReady: async (candidate) => {
          events.push(`ready:${candidate.agentId}`);
        },
      },
      { concurrency: 3, canaryCount: 2 }
    );

    const activationIndex = events.indexOf('activate');
    assert(activationIndex >= candidates.length);
    assert.deepStrictEqual(events.slice(activationIndex, activationIndex + 5), [
      'activate',
      'start:agent-0',
      'ready:agent-0',
      'start:agent-1',
      'ready:agent-1',
    ]);
    assert.strictEqual(result.haltedAfter, null);
    assert.strictEqual(result.activated, true);
    assert(result.outcomes.every((outcome) => outcome.outcome === 'migrated'));
  });

  await test('fleet preflight failure leaves every candidate untouched', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      agentId: `agent-${index}`,
      workflowId: `workflow-${index}`,
    }));
    const prepared = new Set<string>();
    let preflightCompleted = 0;
    let activated = false;
    let started = false;
    const result = await runWorkflowDeploymentCutover(
      candidates,
      {
        preflight: async (candidate) => {
          preflightCompleted += 1;
          if (candidate.agentId === 'agent-2') throw new Error('malformed root');
          return { outcome: 'ready' };
        },
        prepare: async (candidate) => {
          prepared.add(candidate.agentId);
          return { outcome: 'prepared', prepared: candidate.agentId };
        },
        activate: async () => {
          activated = true;
        },
        start: async () => {
          started = true;
          return { workflowId: 'unexpected' };
        },
        waitUntilReady: async () => undefined,
      },
      { concurrency: 3, canaryCount: 2 }
    );

    assert.strictEqual(preflightCompleted, candidates.length);
    assert.strictEqual(prepared.size, 0);
    assert.strictEqual(activated, false);
    assert.strictEqual(started, false);
    assert.strictEqual(result.haltedAfter, 'preflight');
    assert.strictEqual(result.outcomes.filter((outcome) => outcome.outcome === 'failed').length, 1);
  });

  await test('real verifier preflight leaves a healthy peer byte-for-byte unchanged', async () => {
    const runId = `workflow-preflight-${randomUUID()}`;
    const healthy = await createAgent(runId, 'PAUSED');
    const malformed = await createAgent(runId, 'PAUSED', { verifier: false });
    const healthyBefore = await prisma.agent.findUniqueOrThrow({ where: { id: healthy } });
    let prepareCalls = 0;
    try {
      const result = await runWorkflowDeploymentCutover(
        [
          {
            agentId: healthy,
            workflowId: healthyBefore.temporalWorkflowId!,
            status: healthyBefore.status,
          },
          {
            agentId: malformed,
            workflowId: `workflow-${malformed}`,
            status: 'PAUSED',
          },
        ],
        {
          preflight: async (candidate) => {
            const preflight = await preflightAgentWorkflowReplacement(
              candidate.agentId,
              undefined,
              { expectedWorkflowId: candidate.workflowId },
              {
                captureInProgressTools: async () => [],
                readLaunchConfig: async () => ({ maxIterations: null, contextGates: null }),
              }
            );
            if (preflight.outcome === 'failed') throw new Error(preflight.error);
            return preflight;
          },
          prepare: async () => {
            prepareCalls += 1;
            throw new Error('prepare must not run');
          },
          activate: async () => {
            throw new Error('activate must not run');
          },
          start: async () => {
            throw new Error('start must not run');
          },
          waitUntilReady: async () => undefined,
        },
        { concurrency: 2, canaryCount: 1 }
      );
      assert.strictEqual(result.haltedAfter, 'preflight');
      assert.strictEqual(prepareCalls, 0);
      assert.deepStrictEqual(
        await prisma.agent.findUniqueOrThrow({ where: { id: healthy } }),
        healthyBefore
      );
    } finally {
      await prisma.agent.deleteMany({ where: { userId: runId } });
    }
  });

  await test('failed canary blocks every prepared bulk start', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      agentId: `agent-${index}`,
      workflowId: `workflow-${index}`,
    }));
    const starts: string[] = [];
    const result = await runWorkflowDeploymentCutover(
      candidates,
      {
        preflight: async () => ({ outcome: 'ready' }),
        prepare: async (candidate) => ({ outcome: 'prepared', prepared: candidate.agentId }),
        activate: async () => undefined,
        start: async (candidate) => {
          starts.push(candidate.agentId);
          return { workflowId: `new-${candidate.agentId}` };
        },
        waitUntilReady: async (candidate) => {
          if (candidate.agentId === 'agent-1') throw new Error('candidate failed');
        },
      },
      { concurrency: 4, canaryCount: 2 }
    );

    assert.deepStrictEqual(starts, ['agent-0', 'agent-1']);
    assert.strictEqual(result.haltedAfter, 'canary');
    assert.strictEqual(result.outcomes[0].outcome, 'migrated');
    assert.strictEqual(result.outcomes[1].outcome, 'failed');
    assert(result.outcomes.slice(2).every((outcome) => outcome.outcome === 'prepared'));
  });

  await test('activation marker is exact-build scoped, durable, and starts only when absent', async () => {
    const buildId = 'a'.repeat(40);
    const deploymentToken = '1001-2';
    const markerId = workerDeploymentActivationWorkflowId(buildId, deploymentToken);
    assert.strictEqual(markerId, `navi-worker-deployment-activation:${buildId}:${deploymentToken}`);
    assert.notStrictEqual(markerId, workerDeploymentActivationWorkflowId(buildId, '1001-1'));
    assert.throws(
      () => workerDeploymentActivationWorkflowId('not-a-sha', deploymentToken),
      /40-character Git SHA/
    );
    assert.throws(
      () => workerDeploymentActivationWorkflowId(buildId, 'unsafe:token'),
      /deployment token/
    );

    let starts = 0;
    const existingClient = {
      withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
      workflow: {
        getHandle: () => ({ describe: async () => ({ status: { name: 'RUNNING' } }) }),
        start: async () => {
          starts += 1;
        },
      },
    };
    assert.strictEqual(
      await activateTemporalWorkerBuildWithClient(
        existingClient as never,
        buildId,
        deploymentToken
      ),
      markerId
    );
    assert.strictEqual(starts, 0);

    const missingClient = {
      withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
      workflow: {
        getHandle: () => ({
          describe: async () => {
            throw new WorkflowNotFoundError('missing', markerId, undefined);
          },
        }),
        start: async (_workflowType: string, options: { workflowId: string }) => {
          assert.strictEqual(options.workflowId, markerId);
          starts += 1;
        },
      },
    };
    assert.strictEqual(
      await activateTemporalWorkerBuildWithClient(missingClient as never, buildId, deploymentToken),
      markerId
    );
    assert.strictEqual(starts, 1);
  });

  await test('marker cleanup retires old attempts but never the current deployment', async () => {
    const buildId = 'f'.repeat(40);
    const currentMarker = workerDeploymentActivationWorkflowId(buildId, '2001-2');
    const oldSameBuild = workerDeploymentActivationWorkflowId(buildId, '2001-1');
    const oldOtherBuild = workerDeploymentActivationWorkflowId('e'.repeat(40), '1999-1');
    const terminated: string[] = [];
    const markerClient = {
      withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
      workflow: {
        list: async function* () {
          yield { workflowId: currentMarker, runId: 'current-run' };
          yield { workflowId: oldSameBuild, runId: 'old-same-run' };
          yield { workflowId: oldOtherBuild, runId: 'old-other-run' };
          yield { workflowId: 'unrelated', runId: 'unrelated-run' };
        },
        getHandle: (workflowId: string, runId: string) => ({
          terminate: async () => {
            terminated.push(`${workflowId}:${runId}`);
          },
        }),
      },
    };

    const retired = await cleanupSupersededWorkerActivationMarkersWithClient(
      markerClient as never,
      currentMarker
    );
    assert.strictEqual(retired, 2);
    assert.deepStrictEqual(terminated, [
      `${oldSameBuild}:old-same-run`,
      `${oldOtherBuild}:old-other-run`,
    ]);
  });

  await test('bootstrap wait requires durable READY and fails closed on timeout or advance', async () => {
    let clock = 0;
    let reads = 0;
    await waitForWorkflowReplacementBootstrap('agent-ack', 'workflow-new', {
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      readState: async () => {
        reads += 1;
        return {
          temporalWorkflowId: 'workflow-new',
          workflowReplacementToken: reads < 3 ? 'claim' : null,
          status: reads < 3 ? 'STARTING_UP' : 'ACTIVE',
          statusMessage: null,
        };
      },
    });
    assert.strictEqual(reads, 3);

    clock = 0;
    await assert.rejects(
      waitForWorkflowReplacementBootstrap('agent-timeout', 'workflow-new', {
        timeoutMs: 20,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        readState: async () => ({
          temporalWorkflowId: 'workflow-new',
          workflowReplacementToken: 'claim',
          status: 'STARTING_UP',
          statusMessage: null,
        }),
      }),
      /did not bootstrap/
    );

    await assert.rejects(
      waitForWorkflowReplacementBootstrap('agent-advanced', 'workflow-new', {
        readState: async () => ({
          temporalWorkflowId: 'workflow-newer',
          workflowReplacementToken: null,
          status: 'ACTIVE',
          statusMessage: null,
        }),
      }),
      /workflow advanced/
    );

    await assert.rejects(
      waitForWorkflowReplacementBootstrap('agent-early-ack', 'workflow-new', {
        readState: async () => ({
          temporalWorkflowId: 'workflow-new',
          workflowReplacementToken: null,
          status: 'STARTING_UP',
          statusMessage: null,
        }),
      }),
      /before durable readiness/
    );

    await assert.rejects(
      waitForWorkflowReplacementBootstrap('agent-failed', 'workflow-new', {
        readState: async () => ({
          temporalWorkflowId: 'workflow-new',
          workflowReplacementToken: 'claim',
          status: 'FAILED',
          statusMessage: 'bootstrap activity failed',
        }),
      }),
      /bootstrap activity failed/
    );

    for (const status of ['PAUSED', 'COST_LIMIT_REACHED', 'OUT_OF_CREDITS'] as AgentStatus[]) {
      await waitForWorkflowReplacementBootstrap(`agent-${status}`, 'workflow-new', {
        readState: async () => ({
          temporalWorkflowId: 'workflow-new',
          workflowReplacementToken: null,
          status,
          statusMessage: 'restored',
        }),
      });
    }
  });

  finish();
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  await prisma.$disconnect();
  process.exit(1);
});
