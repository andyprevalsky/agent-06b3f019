#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { resumeAgentWorkflow } from '../../providers/agentResume';
import { prisma } from '../../providers/database';
import { claimWorkflowReplacement } from '../../providers/workflowReplacementState';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('agent resume unit tests');

async function createAgent(overrides: {
  temporalWorkflowId?: string | null;
  status?: 'PAUSED' | 'COST_LIMIT_REACHED' | 'OUT_OF_CREDITS';
}) {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `unit-user-${id}`,
      goal: 'unit resume test',
      status: overrides.status ?? 'PAUSED',
      busId: id,
      temporalWorkflowId: overrides.temporalWorkflowId,
    },
  });
  return id;
}

async function main(): Promise<void> {
  await test('resume marks ACTIVE when no workflow signal is required', async () => {
    const agentId = await createAgent({ temporalWorkflowId: null });
    try {
      assert.deepStrictEqual(await resumeAgentWorkflow(agentId), { success: true });
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(agent.status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('failed live signal rolls a persisted PAUSED intent back', async () => {
    const agentId = await createAgent({ temporalWorkflowId: `wf-${randomUUID()}` });
    try {
      const result = await resumeAgentWorkflow(agentId, {
        signalResume: async () => {
          throw new Error('synthetic signal outage');
        },
      });
      assert.deepStrictEqual(result, {
        error: 'Cannot resume agent because its workflow is not running',
        status: 409,
      });
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(agent.status, 'PAUSED');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('live workflow receives resume while durable PAUSED intent becomes ACTIVE', async () => {
    const workflowId = `wf-${randomUUID()}`;
    const agentId = await createAgent({ temporalWorkflowId: workflowId });
    const signals: string[] = [];
    try {
      assert.deepStrictEqual(
        await resumeAgentWorkflow(agentId, {
          signalResume: async (signaledWorkflowId) => {
            signals.push(signaledWorkflowId);
          },
        }),
        { success: true }
      );
      assert.deepStrictEqual(signals, [workflowId]);
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(agent.status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('cost and credit states remain worker-validated', async () => {
    for (const status of ['COST_LIMIT_REACHED', 'OUT_OF_CREDITS'] as const) {
      const workflowId = `wf-${randomUUID()}`;
      const agentId = await createAgent({ temporalWorkflowId: workflowId, status });
      try {
        assert.deepStrictEqual(
          await resumeAgentWorkflow(agentId, { signalResume: async () => undefined }),
          { success: true }
        );
        const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(agent.status, status);
      } finally {
        await prisma.agent.deleteMany({ where: { id: agentId } });
      }
    }
  });

  await test('resume during an existing replacement updates its durable snapshot', async () => {
    const agentId = await createAgent({ temporalWorkflowId: `wf-${randomUUID()}` });
    try {
      const claim = await claimWorkflowReplacement(agentId);
      let signaled = false;
      assert.deepStrictEqual(
        await resumeAgentWorkflow(agentId, {
          signalResume: async () => {
            signaled = true;
          },
        }),
        { success: true }
      );
      assert.strictEqual(signaled, false);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const resumeState = stored.workflowReplacementState as { prior_status?: string };
      assert.strictEqual(stored.temporalWorkflowId, claim.plannedWorkflowId);
      assert.strictEqual(stored.status, 'ACTIVE');
      assert.strictEqual(resumeState.prior_status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('credit restoration during replacement becomes a durable ACTIVE intent', async () => {
    const agentId = await createAgent({
      temporalWorkflowId: `wf-${randomUUID()}`,
      status: 'OUT_OF_CREDITS',
    });
    try {
      const claim = await claimWorkflowReplacement(agentId);
      let signaled = false;
      assert.deepStrictEqual(
        await resumeAgentWorkflow(agentId, {
          hasCredits: async () => true,
          signalResume: async () => {
            signaled = true;
          },
        }),
        { success: true }
      );
      assert.strictEqual(signaled, false);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const resumeState = stored.workflowReplacementState as { prior_status?: string };
      assert.strictEqual(stored.temporalWorkflowId, claim.plannedWorkflowId);
      assert.strictEqual(stored.status, 'ACTIVE');
      assert.strictEqual(resumeState.prior_status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('replacement resume keeps OUT_OF_CREDITS when credit check fails', async () => {
    const agentId = await createAgent({
      temporalWorkflowId: `wf-${randomUUID()}`,
      status: 'OUT_OF_CREDITS',
    });
    try {
      const claim = await claimWorkflowReplacement(agentId);
      assert.deepStrictEqual(
        await resumeAgentWorkflow(agentId, { hasCredits: async () => false }),
        {
          error: 'Cannot resume agent because the user has no credits',
          status: 409,
        }
      );
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const resumeState = stored.workflowReplacementState as { prior_status?: string };
      assert.strictEqual(stored.temporalWorkflowId, claim.plannedWorkflowId);
      assert.strictEqual(stored.status, 'STARTING_UP');
      assert.strictEqual(resumeState.prior_status, 'OUT_OF_CREDITS');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('claim beginning after resume persistence wins a lost signal race', async () => {
    const workflowId = `wf-${randomUUID()}`;
    const agentId = await createAgent({ temporalWorkflowId: workflowId });
    try {
      const result = await resumeAgentWorkflow(agentId, {
        signalResume: async () => {
          await claimWorkflowReplacement(agentId);
          throw new Error('old workflow closed during signal');
        },
      });
      assert.deepStrictEqual(result, { success: true });
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const resumeState = stored.workflowReplacementState as { prior_status?: string };
      assert.strictEqual(stored.status, 'STARTING_UP');
      assert.strictEqual(resumeState.prior_status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
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
