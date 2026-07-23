#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { type AgentStatus } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { clearWorkflowForTerminalAgent } from '../../domains/agents/repoMutations';
import { prisma } from '../../providers/database';
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

async function forceCleanup(
  agentIds: string[],
  dependencies: WorkflowTerminalCleanupDependencies
) {
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
      assert.strictEqual(
        await prisma.temporalWorkflowCleanup.count({ where: { agentId } }),
        1
      );
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
      assert.deepStrictEqual(terminations, [
        `${agentId}:workflow-${agentId}:first-${agentId}`,
      ]);
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
      assert.deepStrictEqual(terminations, [
        `${agentId}:workflow-${agentId}:first-${agentId}`,
      ]);
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
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'COMPLETED' } });
      assert.strictEqual(
        (
          await clearWorkflowForTerminalAgent(
            agentId,
            'COMPLETED',
            workflowA,
            `first-${agentId}`
          )
        ).count,
        1
      );
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
        (
          await clearWorkflowForTerminalAgent(
            agentId,
            'FAILED',
            workflowB,
            `first-b-${agentId}`
          )
        ).count,
        1
      );
      assert.strictEqual(
        await prisma.temporalWorkflowCleanup.count({ where: { agentId } }),
        2
      );

      const terminations: string[] = [];
      await forceCleanup([agentId], successfulDependencies(terminations));
      assert.deepStrictEqual(new Set(terminations), new Set([
        `${agentId}:${workflowA}:first-${agentId}`,
        `${agentId}:${workflowB}:first-b-${agentId}`,
      ]));
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

  await test('two replicas converge on one exact termination', async () => {
    const runId = `workflow-terminal-replicas-${randomUUID()}`;
    const agentId = await createAgent(runId, 'FAILED');
    const terminations: string[] = [];
    try {
      await Promise.all([
        forceCleanup([agentId], successfulDependencies(terminations)),
        forceCleanup([agentId], successfulDependencies(terminations)),
      ]);
      assert.deepStrictEqual(terminations, [
        `${agentId}:workflow-${agentId}:first-${agentId}`,
      ]);
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
