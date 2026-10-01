#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  deliverUserMessageToWorkflow,
  resumeAgentWorkflow,
  resumePausedAgentForUserMessage,
} from '../../providers/agentResume';
import { prisma } from '../../providers/database';
import { claimWorkflowReplacement } from '../../providers/workflowReplacementState';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('agent resume unit tests');

async function createAgent(overrides: {
  temporalWorkflowId?: string | null;
  status?: 'PAUSED' | 'ACTIVE' | 'COST_LIMIT_REACHED' | 'OUT_OF_CREDITS';
  parent?: { id: string; workflowId: string };
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
      parentAgentId: overrides.parent?.id,
      parentWorkflowId: overrides.parent?.workflowId,
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

  await test('a user message lifts a user pause', async () => {
    const workflowId = `wf-${randomUUID()}`;
    const agentId = await createAgent({ temporalWorkflowId: workflowId });
    const signals: string[] = [];
    try {
      const resumed = await resumePausedAgentForUserMessage(agentId, {
        signalResume: async (signaledWorkflowId) => {
          signals.push(signaledWorkflowId);
        },
      });
      assert.strictEqual(resumed, true);
      assert.deepStrictEqual(signals, [workflowId]);
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(agent.status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('a user message never signals resume outside a user pause', async () => {
    for (const status of ['ACTIVE', 'COST_LIMIT_REACHED', 'OUT_OF_CREDITS'] as const) {
      const agentId = await createAgent({ temporalWorkflowId: `wf-${randomUUID()}`, status });
      let signaled = false;
      try {
        const resumed = await resumePausedAgentForUserMessage(agentId, {
          signalResume: async () => {
            signaled = true;
          },
        });
        assert.strictEqual(resumed, false, status);
        assert.strictEqual(signaled, false, status);
        const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(agent.status, status);
      } finally {
        await prisma.agent.deleteMany({ where: { id: agentId } });
      }
    }
    assert.strictEqual(await resumePausedAgentForUserMessage(randomUUID()), false);
  });

  await test('a user message to a child leaves it paused while its parent is held', async () => {
    for (const parentStatus of ['PAUSED', 'COST_LIMIT_REACHED'] as const) {
      const parentWorkflowId = `wf-${randomUUID()}`;
      const parentId = await createAgent({
        status: parentStatus,
        temporalWorkflowId: parentWorkflowId,
      });
      const childId = await createAgent({
        temporalWorkflowId: `wf-${randomUUID()}`,
        parent: { id: parentId, workflowId: parentWorkflowId },
      });
      let signaled = false;
      try {
        const resumed = await resumePausedAgentForUserMessage(childId, {
          signalResume: async () => {
            signaled = true;
          },
        });
        assert.strictEqual(resumed, false, parentStatus);
        assert.strictEqual(signaled, false, parentStatus);
        const child = await prisma.agent.findUniqueOrThrow({ where: { id: childId } });
        assert.strictEqual(child.status, 'PAUSED');
      } finally {
        await prisma.agent.deleteMany({ where: { id: { in: [childId, parentId] } } });
      }
    }
  });

  await test('a user message resumes a child whose parent is running', async () => {
    const parentWorkflowId = `wf-${randomUUID()}`;
    const parentId = await createAgent({ status: 'ACTIVE', temporalWorkflowId: parentWorkflowId });
    const childId = await createAgent({
      temporalWorkflowId: `wf-${randomUUID()}`,
      parent: { id: parentId, workflowId: parentWorkflowId },
    });
    try {
      const resumed = await resumePausedAgentForUserMessage(childId, {
        signalResume: async () => undefined,
      });
      assert.strictEqual(resumed, true);
    } finally {
      await prisma.agent.deleteMany({ where: { id: { in: [childId, parentId] } } });
    }
  });

  await test('a user message during a replacement lifts the saved pause', async () => {
    const agentId = await createAgent({ temporalWorkflowId: `wf-${randomUUID()}` });
    try {
      await claimWorkflowReplacement(agentId);
      let signaled = false;
      const resumed = await resumePausedAgentForUserMessage(agentId, {
        signalResume: async () => {
          signaled = true;
        },
      });
      assert.strictEqual(resumed, true);
      assert.strictEqual(signaled, false);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const resumeState = stored.workflowReplacementState as { prior_status?: string };
      assert.strictEqual(resumeState.prior_status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('a user message keeps the pause when the resume signal fails', async () => {
    const agentId = await createAgent({ temporalWorkflowId: `wf-${randomUUID()}` });
    try {
      const resumed = await resumePausedAgentForUserMessage(agentId, {
        signalResume: async () => {
          throw new Error('synthetic signal outage');
        },
      });
      assert.strictEqual(resumed, false);
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(agent.status, 'PAUSED');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('delivering a message signals it, then lifts the pause', async () => {
    const workflowId = `wf-${randomUUID()}`;
    const agentId = await createAgent({ temporalWorkflowId: workflowId });
    const signals: string[] = [];
    try {
      const delivered = await deliverUserMessageToWorkflow(agentId, workflowId, 'Use Amazon', {
        signalUserResponse: async (id, value) => {
          signals.push(`receive_user_response:${id}:${value}`);
        },
        signalResume: async (id) => {
          signals.push(`resume:${id}`);
        },
      });
      assert.deepStrictEqual(delivered, { signaled: true, resumed: true });
      assert.deepStrictEqual(signals, [
        `receive_user_response:${workflowId}:Use Amazon`,
        `resume:${workflowId}`,
      ]);
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(agent.status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('a lost message signal still lifts the pause; the loop polls the row', async () => {
    const workflowId = `wf-${randomUUID()}`;
    const agentId = await createAgent({ temporalWorkflowId: workflowId });
    try {
      const delivered = await deliverUserMessageToWorkflow(agentId, workflowId, 'Use Amazon', {
        signalUserResponse: async () => {
          throw new Error('synthetic signal outage');
        },
        signalResume: async () => undefined,
      });
      assert.deepStrictEqual(delivered, { signaled: false, resumed: true });
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(agent.status, 'ACTIVE');
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
