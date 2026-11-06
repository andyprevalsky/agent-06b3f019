import assert from 'node:assert';
import { prisma } from '../../providers/database';
import * as agentRepo from '../../domains/agents/repo';
import {
  claimWorkflowReplacement,
  recordWorkflowResumeIntent,
  rollbackWorkflowResumeIntent,
  finalizeWorkflowReplacementBootstrap,
} from '../../providers/workflowReplacementState';
import { createTestHarness } from './trace-archive-test-utils';

export async function testAgentControlIntentCases(
  test: ReturnType<typeof createTestHarness>['test'],
  createAgent: () => Promise<string>
) {
  await test('queued reports cannot revoke accepted user pause on either status path', async () => {
    for (const legacy of [false, true]) {
      const agentId = await createAgent();
      const generation = legacy ? undefined : agentId;
      const queued = [
        { status: 'ACTIVE' },
        { status: 'STARTING_UP' },
        { status: { set: 'ACTIVE' } },
        { status: { set: 'STARTING_UP' } },
      ] as const;
      try {
        const paused = await agentRepo.pauseAgentUnderWorkflowLock(agentId);
        assert.strictEqual(paused?.userControlRevision, 1);
        assert.strictEqual(
          (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).userControlPaused,
          true
        );
        for (const report of queued) {
          const result = await agentRepo.updateAgentForWorkflow(agentId, generation, report);
          assert.strictEqual(result.accepted, false);
          assert.strictEqual(result.agent?.status, 'PAUSED');
          assert.strictEqual(result.agent?.userControlRevision, 1);
        }
        const accounting = await agentRepo.updateAgentForWorkflow(agentId, generation, {
          ownCostCents: 52,
          workflowIterationOffset: 10,
        });
        assert.strictEqual(accounting.accepted, true);
        assert.strictEqual(accounting.agent?.status, 'PAUSED');
        assert.strictEqual(accounting.agent?.workflowIterationOffset, 10);
        const resumed = await recordWorkflowResumeIntent(agentId);
        assert.strictEqual(resumed.outcome, 'ready');
        await agentRepo.updateAgentForWorkflow(agentId, generation, { status: 'PAUSED' });
        const active = await agentRepo.updateAgentForWorkflow(agentId, generation, {
          status: 'ACTIVE',
        });
        assert.strictEqual(active.accepted, true);
        assert.strictEqual(active.agent?.userControlRevision, 2);
        assert.strictEqual(active.agent?.userControlPaused, false);
        await agentRepo.pauseAgentUnderWorkflowLock(agentId);
        const terminal = await agentRepo.updateAgentForWorkflow(agentId, generation, {
          status: 'COMPLETED',
        });
        assert.strictEqual(terminal.accepted, true);
        assert.strictEqual(terminal.agent?.status, 'COMPLETED');
      } finally {
        await prisma.agent.deleteMany({ where: { id: agentId } });
      }
    }
  });

  await test('durable pause intent survives failed resume and replacement but not a completed lifecycle', async () => {
    const agentId = await createAgent();
    try {
      await agentRepo.pauseAgentUnderWorkflowLock(agentId);
      await recordWorkflowResumeIntent(agentId);
      assert.strictEqual(await rollbackWorkflowResumeIntent(agentId, agentId, 2), true);
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).userControlPaused,
        true
      );
      const claim = await claimWorkflowReplacement(agentId);
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).userControlPaused,
        true
      );
      await finalizeWorkflowReplacementBootstrap(agentId, claim.plannedWorkflowId, {
        status: 'ACTIVE',
        progress: 0,
        tokenCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        contextSize: 0,
        messageCount: 0,
      });
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).status,
        'PAUSED'
      );
      await recordWorkflowResumeIntent(agentId);
      await agentRepo.updateAgentForWorkflow(agentId, claim.plannedWorkflowId, {
        status: 'COMPLETED',
      });
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).userControlPaused,
        false
      );
      await prisma.agent.update({ where: { id: agentId }, data: { userControlPaused: true } });
      const restarted = await claimWorkflowReplacement(agentId);
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).userControlPaused,
        false
      );
      const active = await agentRepo.updateAgentForWorkflow(agentId, restarted.plannedWorkflowId, {
        status: 'ACTIVE',
      });
      assert.strictEqual(active.accepted, true);
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('old resume failure cannot roll back a newer pause/resume at the same workflow', async () => {
    const agentId = await createAgent();
    try {
      await agentRepo.pauseAgentUnderWorkflowLock(agentId);
      const first = await recordWorkflowResumeIntent(agentId);
      assert.strictEqual(first.outcome, 'ready');
      await agentRepo.pauseAgentUnderWorkflowLock(agentId);
      await recordWorkflowResumeIntent(agentId);
      assert.strictEqual(await rollbackWorkflowResumeIntent(agentId, agentId, 2), false);
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(row.userControlRevision, 4);
      assert.strictEqual(row.status, 'ACTIVE');
      assert.strictEqual(row.userControlPaused, false);
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });
}
