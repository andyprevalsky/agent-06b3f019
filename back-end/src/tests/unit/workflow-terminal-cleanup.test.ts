#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { type AgentStatus } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { clearWorkflowForTerminalAgent } from '../../domains/agents/repoMutations';
import { prisma } from '../../providers/database';
import { createMessage } from '../../providers/messages';
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

const { test, finish } = createTestHarness('workflow terminal cleanup unit tests');

async function createAgent(runId: string, status: AgentStatus = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: runId,
      goal: `terminal cleanup ${status}`,
      status,
      busId: id,
      temporalWorkflowId: `workflow-${id}`,
      temporalFirstExecutionRunId: `first-${id}`,
      toolsInUse: ['web_search'],
      verifier: { create: {} },
    },
  });
  return id;
}

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

async function deleteRun(runId: string): Promise<void> {
  await prisma.agent.deleteMany({ where: { userId: runId } });
}

function successfulDependencies(terminations: string[]): WorkflowTerminalCleanupDependencies {
  return {
    resolveExecution: async () => {
      throw new Error('stored first-run identity should avoid describe');
    },
    terminate: async (execution, agentId) => {
      terminations.push(`${agentId}:${execution.workflowId}:${execution.firstExecutionRunId}`);
    },
    captureInProgressTools: async () => [],
    finalizeInterruptedTools: async () => ({ interrupted: 0 }),
  };
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
  await test('terminal grace protects normal final-summary tail work', async () => {
    const runId = `workflow-terminal-grace-${randomUUID()}`;
    const agentId = await createAgent(runId);
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
    let terminated = false;
    try {
      const result = await cleanupTerminalAgentWorkflowZombies(
        {
          ...successfulDependencies([]),
          terminate: async () => {
            terminated = true;
          },
        },
        { agentIds: [agentId] }
      );
      assert.strictEqual(result.discovered, 0);
      assert.strictEqual(terminated, false);
      assert.strictEqual(await prisma.temporalWorkflowCleanup.count({ where: { agentId } }), 1);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('forced cleanup terminates exact chain and clears stale running UI', async () => {
    const runId = `workflow-terminal-forced-${randomUUID()}`;
    const agentId = await createAgent(runId);
    const workflowId = `workflow-${agentId}`;
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
    const events: string[] = [];
    try {
      const result = await forceCleanup([agentId], {
        ...successfulDependencies(events),
        captureInProgressTools: async () => {
          events.push('capture');
          return [];
        },
        finalizeInterruptedTools: async () => {
          events.push('finalize');
          return { interrupted: 0 };
        },
      });
      assert.strictEqual(result.discovered, 1);
      assert.strictEqual(result.terminated, 1);
      assert(events.includes(`${agentId}:${workflowId}:first-${agentId}`));
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.status, 'COMPLETED');
      assert(after.temporalWorkflowId?.includes(':deployment-sealed:'));
      assert.deepStrictEqual(after.toolsInUse, []);
      assert.strictEqual(after.temporalCleanupPending, false);
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('already-closed workflow clears exact obligation without terminate', async () => {
    const runId = `workflow-terminal-closed-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    await prisma.temporalWorkflowCleanup.update({
      where: {
        agentId_workflowId: { agentId, workflowId: `workflow-${agentId}` },
      },
      data: { firstExecutionRunId: null },
    });
    let terminated = false;
    try {
      await forceCleanup([agentId], {
        ...successfulDependencies([]),
        resolveExecution: async (workflowId) => {
          throw new WorkflowNotFoundError('closed', workflowId, undefined);
        },
        terminate: async () => {
          terminated = true;
        },
      });
      assert.strictEqual(terminated, false);
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('failure retains identity with backoff and later retry is exact', async () => {
    const runId = `workflow-terminal-retry-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    try {
      await assert.rejects(
        forceCleanup([agentId], {
          ...successfulDependencies([]),
          terminate: async () => {
            throw new Error('synthetic termination outage');
          },
        }),
        /cleanup obligation.*failed/i
      );
      const retained = await prisma.temporalWorkflowCleanup.findUniqueOrThrow({
        where: { agentId_workflowId: { agentId, workflowId: `workflow-${agentId}` } },
      });
      assert.strictEqual(retained.firstExecutionRunId, `first-${agentId}`);
      assert.strictEqual(retained.attemptCount, 1);
      assert.strictEqual(retained.leaseToken, null);
      assert.match(retained.lastError ?? '', /synthetic termination outage/);

      const terminations: string[] = [];
      await forceCleanup([agentId], successfulDependencies(terminations));
      assert.deepStrictEqual(terminations, [`${agentId}:workflow-${agentId}:first-${agentId}`]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('soft-deleted live workflow remains an exact obligation', async () => {
    const runId = `workflow-terminal-deleted-${randomUUID()}`;
    const agentId = await createAgent(runId);
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    const terminations: string[] = [];
    try {
      await forceCleanup([agentId], successfulDependencies(terminations));
      assert.deepStrictEqual(terminations, [`${agentId}:workflow-${agentId}:first-${agentId}`]);
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert(after.deletedAt instanceof Date);
      assert.strictEqual(after.temporalCleanupPending, false);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('two reactivations before sweep preserve both generations', async () => {
    const runId = `workflow-terminal-overlap-${randomUUID()}`;
    const agentId = await createAgent(runId);
    const workflowA = `workflow-${agentId}`;
    const workflowB = `workflow-b-${agentId}`;
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          status: 'COMPLETED',
          progress: 1,
          statusMessage: 'Task completed',
          responseSchema: { fields: [{ name: 'order_confirmation_id', type: 'str' }] },
          structuredResponse: { order_confirmation_id: 'dff187de' },
          toolsInUse: ['spawn_browser_agent'],
        },
      });
      assert.strictEqual(
        (await clearWorkflowForTerminalAgent(agentId, 'COMPLETED', workflowA, `first-${agentId}`))
          .count,
        1
      );
      const cleared = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(cleared.responseSchema, null);
      assert.strictEqual(cleared.structuredResponse, null);
      assert.strictEqual(cleared.progress, 0);
      assert.deepStrictEqual(cleared.toolsInUse, []);
      assert.strictEqual(cleared.statusMessage, null);
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          status: 'ACTIVE',
          temporalWorkflowId: workflowB,
          temporalFirstExecutionRunId: `first-b-${agentId}`,
        },
      });
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'FAILED' } });
      assert.strictEqual(
        (await clearWorkflowForTerminalAgent(agentId, 'FAILED', workflowB, `first-b-${agentId}`))
          .count,
        1
      );
      assert.strictEqual(await prisma.temporalWorkflowCleanup.count({ where: { agentId } }), 2);

      const terminations: string[] = [];
      await forceCleanup([agentId], successfulDependencies(terminations));
      assert.deepStrictEqual(
        new Set(terminations),
        new Set([
          `${agentId}:${workflowA}:first-${agentId}`,
          `${agentId}:${workflowB}:first-b-${agentId}`,
        ])
      );
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.temporalWorkflowId, null);
      assert.strictEqual(after.status, 'ACTIVE');
      assert.strictEqual(after.temporalCleanupPending, false);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('old backend clear of cost/out cold workflows is captured', async () => {
    const runId = `workflow-terminal-old-backend-${randomUUID()}`;
    const cost = await createAgent(runId, 'COST_LIMIT_REACHED');
    const credits = await createAgent(runId, 'OUT_OF_CREDITS');
    try {
      for (const agentId of [cost, credits]) {
        await prisma.agent.update({
          where: { id: agentId },
          data: {
            status: 'ACTIVE',
            temporalWorkflowId: null,
            temporalFirstExecutionRunId: null,
          },
        });
      }
      assert.strictEqual(
        await prisma.temporalWorkflowCleanup.count({
          where: { agentId: { in: [cost, credits] } },
        }),
        2
      );
      await forceCleanup([cost, credits], successfulDependencies([]));
    } finally {
      await deleteRun(runId);
    }
  });

  await test('cleanup preserves a concurrently installed current workflow', async () => {
    const runId = `workflow-terminal-current-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    const currentWorkflow = `new-current-${agentId}`;
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: 'ACTIVE', temporalWorkflowId: currentWorkflow },
    });
    try {
      await forceCleanup([agentId], successfulDependencies([]));
      const after = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(after.temporalWorkflowId, currentWorkflow);
      assert.strictEqual(after.status, 'ACTIVE');
    } finally {
      await deleteRun(runId);
    }
  });

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

  await test('two replicas converge on one exact termination', async () => {
    const runId = `workflow-terminal-replicas-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    const terminations: string[] = [];
    try {
      await Promise.all([
        forceCleanup([agentId], successfulDependencies(terminations)),
        forceCleanup([agentId], successfulDependencies(terminations)),
      ]);
      assert.deepStrictEqual(terminations, [`${agentId}:workflow-${agentId}:first-${agentId}`]);
      await assertNoPendingTerminalAgentWorkflowCleanup([agentId]);
    } finally {
      await deleteRun(runId);
    }
  });

  await test('poison obligation does not starve another agent in the batch', async () => {
    const runId = `workflow-terminal-poison-${randomUUID()}`;
    const poison = await createAgent(runId, 'FAILED');
    const healthy = await createAgent(runId, 'FAILED');
    const finalized: string[] = [];
    try {
      await assert.rejects(
        forceCleanup([poison, healthy], {
          ...successfulDependencies([]),
          terminate: async (_execution, agentId) => {
            if (agentId === poison) throw new Error('poison');
          },
          finalizeInterruptedTools: async (agentId) => {
            finalized.push(agentId);
          },
        }),
        /cleanup obligation.*failed/i
      );
      assert(finalized.includes(healthy));
      assert(!finalized.includes(poison));
      await assertNoPendingTerminalAgentWorkflowCleanup([healthy]);
      assert.strictEqual(
        await prisma.temporalWorkflowCleanup.count({ where: { agentId: poison } }),
        1
      );
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
