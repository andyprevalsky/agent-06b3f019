#!/usr/bin/env tsx
/**
 * Terminal-workflow cleanup must never act on a root agent's follow-up run.
 * Root agents reuse Workflow ID = agent ID for every run, so cleanup owns only
 * the exact generation that went terminal (prod agents 572da2a5, 2dd470aa).
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { WorkflowNotFoundError } from '@temporalio/client';
import { clearWorkflowForTerminalAgent } from '../../domains/agents/repoMutations';
import { prisma } from '../../providers/database';
import { createMessage } from '../../providers/messages';
import { retryWithBackoff } from '../../providers/retry';
import {
  captureInProgressWorkflowTools,
  finalizeInterruptedWorkflowTools,
} from '../../providers/staleWorkflowTools';
import { acceptChatWorkflowExecution } from '../../providers/workflowGeneration';
import {
  assertNoPendingTerminalAgentWorkflowCleanup,
  cleanupTerminalAgentWorkflowZombies,
  type WorkflowTerminalCleanupDependencies,
} from '../../providers/workflowTerminalCleanup';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow terminal cleanup follow-up unit tests');

/** A root agent: every run it ever starts reuses Workflow ID = agent ID. */
async function createRootAgent(runId: string, firstExecutionRunId: string | null): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: runId,
      goal: 'terminal cleanup follow-up run',
      status: 'ACTIVE',
      busId: id,
      temporalWorkflowId: id,
      temporalFirstExecutionRunId: firstExecutionRunId,
      verifier: { create: {} },
    },
  });
  return id;
}

/** The production follow-up path: reopen the completed agent, then escalate a new run. */
async function startFollowUpRun(agentId: string, firstExecutionRunId: string): Promise<void> {
  const before = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert.strictEqual(
    (
      await clearWorkflowForTerminalAgent(
        agentId,
        before.status,
        agentId,
        before.temporalFirstExecutionRunId
      )
    ).count,
    1
  );
  assert.strictEqual(
    await acceptChatWorkflowExecution(agentId, { workflowId: agentId, firstExecutionRunId }),
    true
  );
}

async function postLiveTool(agentId: string, toolCallId: string): Promise<void> {
  await createMessage({
    agentId,
    role: 'TOOL',
    text: '',
    metadata: {
      workflowGeneration: agentId,
      toolCallId,
      toolName: 'spawn_agent',
      toolStatus: 'IN_PROGRESS',
    },
    enforceCurrentWorkflowGeneration: true,
  });
}

async function latestToolStatus(agentId: string, toolCallId: string): Promise<unknown> {
  const rows = await prisma.message.findMany({
    where: { agentId, role: 'TOOL', metadata: { path: ['toolCallId'], equals: toolCallId } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const latest = rows.at(-1)?.metadata as Record<string, unknown> | undefined;
  return latest?.toolStatus;
}

function realToolDependencies(
  terminations: string[],
  runningChain: string | null
): WorkflowTerminalCleanupDependencies {
  return {
    resolveExecution: async (workflowId) => {
      if (runningChain === null) throw new WorkflowNotFoundError('closed', workflowId, undefined);
      return { workflowId, firstExecutionRunId: runningChain };
    },
    terminate: async (execution, agentId) => {
      terminations.push(`${agentId}:${execution.workflowId}:${execution.firstExecutionRunId}`);
    },
    captureInProgressTools: captureInProgressWorkflowTools,
    finalizeInterruptedTools: finalizeInterruptedWorkflowTools,
  };
}

/** The obligation the completion trigger left for the agent's own Workflow ID. */
async function pendingObligation(agentId: string) {
  return prisma.temporalWorkflowCleanup.findUnique({
    where: { agentId_workflowId: { agentId, workflowId: agentId } },
  });
}

async function deleteRun(runId: string): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId: runId } });
}

async function forceCleanup(agentIds: string[], dependencies: WorkflowTerminalCleanupDependencies) {
  return cleanupTerminalAgentWorkflowZombies(dependencies, {
    agentIds,
    ignoreGrace: true,
    batchSize: 20,
    maxConcurrency: 4,
  });
}

async function main(): Promise<void> {
  // Prod agent 572da2a5 (2026-10-12): the first run's start never recorded its
  // first-run ID, so its completion obligation had none. The follow-up run
  // reused Workflow ID = agent ID, and cleanup resolved, sealed, and terminated it.
  await test('follow-up run survives cleanup of an unknown-run completed generation', async () => {
    const runId = `workflow-terminal-follow-up-unknown-${randomUUID()}`;
    const agentId = await createRootAgent(runId, null);
    const followUpRun = `run-2-${agentId}`;
    const liveCall = `live-${agentId}`;
    try {
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
      await startFollowUpRun(agentId, followUpRun);
      await postLiveTool(agentId, liveCall);
      assert.strictEqual((await pendingObligation(agentId))?.firstExecutionRunId, null);

      const terminations: string[] = [];
      await forceCleanup([agentId], realToolDependencies(terminations, followUpRun));

      assert.deepStrictEqual(terminations, []);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.status, 'ACTIVE');
      assert.strictEqual(after.temporalWorkflowId, agentId);
      assert.strictEqual(after.temporalFirstExecutionRunId, followUpRun);
      assert.strictEqual(await latestToolStatus(agentId, liveCall), 'IN_PROGRESS');
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  // Prod agent 2dd470aa (2026-10-12): the obligation named the exact completed
  // chain, but sealing compared only Workflow ID, so the follow-up generation
  // was fenced and every later write returned 409 while its run kept going.
  await test('follow-up run survives cleanup of an exact-run completed generation', async () => {
    const runId = `workflow-terminal-follow-up-exact-${randomUUID()}`;
    const completedRun = `run-1-${randomUUID()}`;
    const agentId = await createRootAgent(runId, completedRun);
    const followUpRun = `run-2-${agentId}`;
    const liveCall = `live-${agentId}`;
    try {
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
      await startFollowUpRun(agentId, followUpRun);
      await postLiveTool(agentId, liveCall);
      assert.strictEqual((await pendingObligation(agentId))?.firstExecutionRunId, completedRun);

      const terminations: string[] = [];
      await forceCleanup([agentId], realToolDependencies(terminations, followUpRun));

      assert.deepStrictEqual(terminations, [`${agentId}:${agentId}:${completedRun}`]);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.status, 'ACTIVE');
      assert.strictEqual(after.temporalWorkflowId, agentId);
      assert.strictEqual(after.temporalFirstExecutionRunId, followUpRun);
      assert.strictEqual(await latestToolStatus(agentId, liveCall), 'IN_PROGRESS');
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('still-terminal agent with an unknown run is still sealed and terminated', async () => {
    const runId = `workflow-terminal-unknown-zombie-${randomUUID()}`;
    const agentId = await createRootAgent(runId, null);
    const zombieRun = `zombie-${agentId}`;
    const liveCall = `zombie-call-${agentId}`;
    try {
      await postLiveTool(agentId, liveCall);
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'FAILED' } });

      const terminations: string[] = [];
      await forceCleanup([agentId], realToolDependencies(terminations, zombieRun));

      assert.deepStrictEqual(terminations, [`${agentId}:${agentId}:${zombieRun}`]);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.status, 'FAILED');
      assert(after.temporalWorkflowId?.includes(':deployment-sealed:'));
      assert.strictEqual(await latestToolStatus(agentId, liveCall), 'FINISHED');
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  // A follow-up start that hits the still-finishing chain adopts it; that
  // chain is the terminal generation, so it keeps the original seal.
  await test('a live agent still on the exact terminal chain is sealed and terminated', async () => {
    const runId = `workflow-terminal-adopted-${randomUUID()}`;
    const terminalRun = `run-1-${randomUUID()}`;
    const agentId = await createRootAgent(runId, terminalRun);
    try {
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
      await startFollowUpRun(agentId, terminalRun);
      assert.strictEqual((await pendingObligation(agentId))?.firstExecutionRunId, terminalRun);

      const terminations: string[] = [];
      await forceCleanup([agentId], realToolDependencies(terminations, terminalRun));

      assert.deepStrictEqual(terminations, [`${agentId}:${agentId}:${terminalRun}`]);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert(after.temporalWorkflowId?.includes(':deployment-sealed:'));
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  // Between runs a reopened agent has no installed workflow, and its next run
  // will reuse Workflow ID = agent ID; an unknown chain under that ID may be
  // the follow-up mid-acceptance, so it is never resolved or finalized.
  await test('a reopened agent between runs keeps its next run and chips', async () => {
    const runId = `workflow-terminal-reopened-${randomUUID()}`;
    const unknownAgent = await createRootAgent(runId, null);
    const knownRun = `run-1-${randomUUID()}`;
    const knownAgent = await createRootAgent(runId, knownRun);
    try {
      for (const agentId of [unknownAgent, knownAgent]) {
        await postLiveTool(agentId, `chip-${agentId}`);
        await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
        const before = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(
          (
            await clearWorkflowForTerminalAgent(
              agentId,
              'COMPLETED',
              agentId,
              before.temporalFirstExecutionRunId
            )
          ).count,
          1
        );
      }

      const terminations: string[] = [];
      await forceCleanup(
        [unknownAgent, knownAgent],
        realToolDependencies(terminations, `next-run-${randomUUID()}`)
      );

      assert.deepStrictEqual(terminations, [`${knownAgent}:${knownAgent}:${knownRun}`]);
      for (const agentId of [unknownAgent, knownAgent]) {
        const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(after.status, 'ACTIVE');
        assert.strictEqual(after.temporalWorkflowId, null);
        assert.strictEqual(await latestToolStatus(agentId, `chip-${agentId}`), 'IN_PROGRESS');
      }
      await assertNoPendingTerminalAgentWorkflowCleanup([unknownAgent, knownAgent]);
    } finally {
      await deleteRun(runId);
    }
  });

  // A follow-up that goes terminal before the earlier generation's cleanup
  // runs lands on the same (agent, Workflow ID) row; it must name the newest
  // chain and give that chain's tail the full grace.
  await test('a later terminal generation retargets the pending obligation', async () => {
    const runId = `workflow-terminal-newest-${randomUUID()}`;
    const firstRun = `run-1-${randomUUID()}`;
    const agentId = await createRootAgent(runId, firstRun);
    const secondRun = `run-2-${agentId}`;
    try {
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
      const firstGrace = (await pendingObligation(agentId))?.notBefore;
      assert(firstGrace instanceof Date);
      await prisma.temporalWorkflowCleanup.update({
        where: { agentId_workflowId: { agentId, workflowId: agentId } },
        data: { notBefore: new Date(firstGrace.getTime() - 4 * 60_000) },
      });
      await startFollowUpRun(agentId, secondRun);
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'FAILED' } });

      const pending = await pendingObligation(agentId);
      assert.strictEqual(pending?.firstExecutionRunId, secondRun);
      assert((pending?.notBefore.getTime() ?? 0) >= firstGrace.getTime() - 1_000);

      const terminations: string[] = [];
      await forceCleanup([agentId], realToolDependencies(terminations, null));
      assert.deepStrictEqual(terminations, [`${agentId}:${agentId}:${secondRun}`]);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert(after.temporalWorkflowId?.includes(':deployment-sealed:'));
    } finally {
      await deleteRun(runId);
    }
  });

  // Reopening an agent does not take the generation lock, so the seal must
  // not overwrite a row that changed after cleanup read it.
  await test('a reopen committed during the seal is never overwritten', async () => {
    const runId = `workflow-terminal-seal-race-${randomUUID()}`;
    const terminalRun = `run-1-${randomUUID()}`;
    const agentId = await createRootAgent(runId, terminalRun);
    try {
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
      let releaseReopen = () => {};
      const reopenMayCommit = new Promise<void>((resolve) => {
        releaseReopen = resolve;
      });
      let announceRowLocked = () => {};
      const rowLocked = new Promise<void>((resolve) => {
        announceRowLocked = resolve;
      });
      const reopen = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${agentId} FOR UPDATE`;
          announceRowLocked();
          await reopenMayCommit;
          await tx.agent.update({
            where: { id: agentId },
            data: { status: 'ACTIVE', temporalWorkflowId: null, temporalFirstExecutionRunId: null },
          });
        },
        { timeout: 30_000 }
      );
      await rowLocked;
      const cleanup = forceCleanup([agentId], realToolDependencies([], terminalRun));
      const sealBlocked = async (): Promise<boolean> => {
        const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE 'UPDATE "public"."Agent"%'`;
        return Number(rows[0]?.waiting ?? 0) > 0;
      };
      const blocked = await retryWithBackoff(sealBlocked, {
        maxRetries: 800,
        fixedDelays: Array.from({ length: 800 }, () => 25),
        shouldRetryResult: (isBlocked) => !isBlocked,
        component: 'SealRaceTest',
      });
      assert(blocked, 'seal never reached the locked row');
      releaseReopen();
      await reopen;
      await assert.rejects(cleanup, /cleanup obligation.*failed/i);

      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.status, 'ACTIVE');
      assert.strictEqual(after.temporalWorkflowId, null);
      const retained = await pendingObligation(agentId);
      assert.strictEqual(retained?.attemptCount, 1);
      assert.match(retained?.lastError ?? '', /generation changed during terminal cleanup/);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('a newer generation landing during the lease is requeued, not deleted', async () => {
    const runId = `workflow-terminal-lease-newer-${randomUUID()}`;
    const firstRun = `run-1-${randomUUID()}`;
    const agentId = await createRootAgent(runId, firstRun);
    const newerRun = `run-2-${agentId}`;
    try {
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
      await prisma.temporalWorkflowCleanup.update({
        where: { agentId_workflowId: { agentId, workflowId: agentId } },
        data: { notBefore: new Date(Date.now() - 1_000) },
      });
      const terminations: string[] = [];
      await cleanupTerminalAgentWorkflowZombies(
        {
          ...realToolDependencies(terminations, null),
          terminate: async (execution, ownerId) => {
            terminations.push(
              `${ownerId}:${execution.workflowId}:${execution.firstExecutionRunId}`
            );
            // While this lease is held, the user reopens the agent, a follow-up
            // run under the same Workflow ID starts, and it fails.
            const sealed = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
            assert.strictEqual(
              (
                await clearWorkflowForTerminalAgent(
                  agentId,
                  sealed.status,
                  sealed.temporalWorkflowId ?? '',
                  null
                )
              ).count,
              1
            );
            assert(
              await acceptChatWorkflowExecution(agentId, {
                workflowId: agentId,
                firstExecutionRunId: newerRun,
              })
            );
            await prisma.agent.update({ where: { id: agentId }, data: { status: 'FAILED' } });
          },
        },
        { agentIds: [agentId], batchSize: 20, maxConcurrency: 4 }
      );
      assert.deepStrictEqual(terminations, [`${agentId}:${agentId}:${firstRun}`]);
      const requeued = await pendingObligation(agentId);
      assert.strictEqual(requeued?.firstExecutionRunId, newerRun);
      assert.strictEqual(requeued?.leaseToken, null);
      assert((requeued?.notBefore.getTime() ?? 0) > Date.now());
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.temporalWorkflowId, agentId);
      assert.strictEqual(after.temporalCleanupPending, true);
    } finally {
      await deleteRun(runId);
    }
  });

  await finish();
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
