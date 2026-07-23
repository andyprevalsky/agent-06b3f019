#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { saveToolUsage, WorkflowGenerationMismatchError } from '../../domains/tool-usage/service';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('tool usage generation fence unit tests');

async function createAgent(
  temporalWorkflowId: string | null,
  workflowIterationOffset = 0
): Promise<{ agentId: string; userId: string }> {
  const agentId = randomUUID();
  const userId = `tool-usage-generation-${agentId}`;
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: 'test tool usage workflow generation fencing',
      temporalWorkflowId,
      workflowIterationOffset,
      status: 'ACTIVE',
    },
  });
  return { agentId, userId };
}

async function main(): Promise<void> {
  await test('current generation inserts usage and advances the maximum LLM iteration', async () => {
    const fixture = await createAgent(null, 4);
    const generation = `${fixture.agentId}:replacement:${randomUUID()}`;
    try {
      await prisma.agent.update({
        where: { id: fixture.agentId },
        data: { temporalWorkflowId: generation },
      });

      const created = await saveToolUsage({
        agent_id: fixture.agentId,
        user_id: fixture.userId,
        tool_name: 'execute_loop',
        total_cost_cents: 7,
        workflow_generation: generation,
        usage_items: [
          { type: 'api_call', iteration: 500 },
          { type: 'llm', iteration: 9 },
          { type: 'llm', iteration: 14 },
          { type: 'llm', iteration: 11 },
          { type: 'llm', iteration: 14.5 },
        ],
      });

      const [storedUsage, storedAgent] = await Promise.all([
        prisma.toolUsage.findUniqueOrThrow({ where: { id: created.id } }),
        prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } }),
      ]);
      assert.strictEqual(storedUsage.agentId, fixture.agentId);
      assert.strictEqual(storedUsage.totalCostCents, 7);
      assert.strictEqual(storedAgent.workflowIterationOffset, 14);

      await saveToolUsage({
        agent_id: fixture.agentId,
        user_id: fixture.userId,
        tool_name: 'verifier_execute',
        total_cost_cents: 1,
        workflow_generation: generation,
        usage_items: [{ type: 'llm', iteration: 8 }],
      });
      const afterOlderIteration = await prisma.agent.findUniqueOrThrow({
        where: { id: fixture.agentId },
      });
      assert.strictEqual(afterOlderIteration.workflowIterationOffset, 14);
    } finally {
      await prisma.agent.deleteMany({ where: { id: fixture.agentId } });
    }
  });

  await test('stale generation inserts no usage and cannot advance iteration state', async () => {
    const fixture = await createAgent(null, 6);
    const currentGeneration = `${fixture.agentId}:replacement:${randomUUID()}`;
    try {
      await prisma.agent.update({
        where: { id: fixture.agentId },
        data: { temporalWorkflowId: currentGeneration },
      });

      await assert.rejects(
        saveToolUsage({
          agent_id: fixture.agentId,
          user_id: fixture.userId,
          tool_name: 'execute_loop',
          total_cost_cents: 99,
          workflow_generation: fixture.agentId,
          usage_items: [{ type: 'llm', iteration: 50 }],
        }),
        WorkflowGenerationMismatchError
      );

      const [usageCount, storedAgent] = await Promise.all([
        prisma.toolUsage.count({ where: { agentId: fixture.agentId } }),
        prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } }),
      ]);
      assert.strictEqual(usageCount, 0);
      assert.strictEqual(storedAgent.workflowIterationOffset, 6);
    } finally {
      await prisma.agent.deleteMany({ where: { id: fixture.agentId } });
    }
  });

  await test('cutover wins atomically over a concurrently arriving stale usage insert', async () => {
    const fixture = await createAgent(null, 5);
    const replacementGeneration = `${fixture.agentId}:replacement:${randomUUID()}`;
    let releaseCutover = () => {};
    let announceCutover = () => {};
    const cutoverAcquired = new Promise<void>((resolve) => {
      announceCutover = resolve;
    });
    const cutoverRelease = new Promise<void>((resolve) => {
      releaseCutover = resolve;
    });

    try {
      const cutover = runTransactionWithRetry(async (tx) => {
        await lockAgentWorkflowGeneration(tx, fixture.agentId);
        announceCutover();
        await cutoverRelease;
        await tx.agent.update({
          where: { id: fixture.agentId },
          data: {
            temporalWorkflowId: replacementGeneration,
            workflowIterationOffset: 9,
          },
        });
      });
      await cutoverAcquired;

      let staleSettled = false;
      const staleAttempt = saveToolUsage({
        agent_id: fixture.agentId,
        user_id: fixture.userId,
        tool_name: 'execute_loop',
        total_cost_cents: 77,
        workflow_generation: fixture.agentId,
        usage_items: [{ type: 'llm', iteration: 30 }],
      })
        .then(
          () => 'created' as const,
          (error: unknown) => {
            assert(error instanceof WorkflowGenerationMismatchError);
            return 'stale' as const;
          }
        )
        .finally(() => {
          staleSettled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(
        staleSettled,
        false,
        'usage insert must wait behind the workflow generation cutover lock'
      );
      releaseCutover();
      const [, staleOutcome] = await Promise.all([cutover, staleAttempt]);
      assert.strictEqual(staleOutcome, 'stale');

      const [usageCount, storedAgent] = await Promise.all([
        prisma.toolUsage.count({ where: { agentId: fixture.agentId } }),
        prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } }),
      ]);
      assert.strictEqual(usageCount, 0);
      assert.strictEqual(storedAgent.temporalWorkflowId, replacementGeneration);
      assert.strictEqual(storedAgent.workflowIterationOffset, 9);
    } finally {
      releaseCutover();
      await prisma.agent.deleteMany({ where: { id: fixture.agentId } });
    }
  });

  await test('legacy generation accepts usage without advancing execute offset from PLAN', async () => {
    const fixture = await createAgent(null, 0);
    try {
      const created = await saveToolUsage({
        agent_id: fixture.agentId,
        user_id: fixture.userId,
        tool_name: 'plan_loop',
        total_cost_cents: 2,
        workflow_generation: fixture.agentId,
        usage_items: [{ type: 'llm', iteration: 3 }],
      });

      const [usageCount, storedAgent] = await Promise.all([
        prisma.toolUsage.count({ where: { id: created.id } }),
        prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } }),
      ]);
      assert.strictEqual(usageCount, 1);
      assert.strictEqual(storedAgent.workflowIterationOffset, 0);
    } finally {
      await prisma.agent.deleteMany({ where: { id: fixture.agentId } });
    }
  });

  finish();
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  await prisma.$disconnect();
  process.exit(1);
});
