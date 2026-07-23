#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { updateAgentStatus } from '../../domains/agents/agentControlService';
import { prisma } from '../../providers/database';
import {
  acknowledgeWorkflowReplacementBootstrap,
  claimWorkflowReplacement,
  finalizeWorkflowReplacementBootstrap,
  markWorkflowReplacementFailed,
  recordWorkflowReplacementStartAcceptance,
} from '../../providers/workflowReplacementState';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness(
  'workflow replacement accounting and bootstrap unit tests'
);

async function createAgent(): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `workflow-replacement-state-unit-${id}`,
      goal: 'test workflow replacement state',
      status: 'ACTIVE',
      busId: id,
    },
  });
  return id;
}

async function withAgent(fn: (agentId: string) => Promise<void>): Promise<void> {
  const agentId = await createAgent();
  try {
    await fn(agentId);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
}

async function main(): Promise<void> {
  await test('cost-limited snapshots distinguish own tokens from child tree tokens', async () => {
    await withAgent(async (agentId) => {
      const childId = randomUUID();
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          temporalWorkflowId: agentId,
          status: 'COST_LIMIT_REACHED',
          tokenCount: 1_250,
          tokensIn: 680,
          tokensOut: 270,
          ownCostCents: 17.25,
          treeCostCents: 29,
        },
      });
      await prisma.agent.create({
        data: {
          id: childId,
          userId: `workflow-restart-unit-${agentId}`,
          goal: 'child accounting state',
          status: 'COST_LIMIT_REACHED',
          busId: agentId,
          parentAgentId: agentId,
          tokenCount: 300,
          tokensIn: 220,
          tokensOut: 80,
          treeCostCents: 12,
        },
      });
      try {
        const claim = await claimWorkflowReplacement(agentId);
        assert.strictEqual(claim.resumeState.prior_status, 'COST_LIMIT_REACHED');
        assert.strictEqual(claim.resumeState.tokens_in, 680);
        assert.strictEqual(claim.resumeState.tokens_out, 270);
        assert.strictEqual(claim.resumeState.tree_tokens_in, 900);
        assert.strictEqual(claim.resumeState.tree_tokens_out, 350);
        assert.strictEqual(claim.resumeState.token_count, 1_250);
      } finally {
        await prisma.agent.deleteMany({ where: { id: childId } });
      }
    });
  });

  await test('active legacy subtree counters are not re-added as root own usage', async () => {
    await withAgent(async (agentId) => {
      const childId = randomUUID();
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          temporalWorkflowId: agentId,
          status: 'ACTIVE',
          tokenCount: 800,
          tokensIn: 900,
          tokensOut: 350,
        },
      });
      await prisma.agent.create({
        data: {
          id: childId,
          userId: `workflow-replacement-state-unit-${agentId}`,
          goal: 'legacy child accounting',
          status: 'ACTIVE',
          parentAgentId: agentId,
          parentWorkflowId: agentId,
          busId: agentId,
          depth: 1,
          tokenCount: 150,
          tokensIn: 300,
          tokensOut: 150,
        },
      });
      await prisma.toolUsage.createMany({
        data: [
          {
            agentId,
            userId: `workflow-replacement-state-unit-${agentId}`,
            toolName: 'execute_loop',
            totalCostCents: 1,
            usageItems: [{ type: 'llm', tokens_in: 600, tokens_out: 200, cost_cents: 1 }],
          },
          {
            agentId: childId,
            userId: `workflow-replacement-state-unit-${agentId}`,
            toolName: 'execute_loop',
            totalCostCents: 1,
            usageItems: [{ type: 'llm', tokens_in: 300, tokens_out: 150, cost_cents: 1 }],
          },
        ],
      });
      try {
        const claim = await claimWorkflowReplacement(agentId);
        assert.strictEqual(claim.resumeState.tokens_in, 600);
        assert.strictEqual(claim.resumeState.tokens_out, 200);
        assert.strictEqual(claim.resumeState.tree_tokens_in, 900);
        assert.strictEqual(claim.resumeState.tree_tokens_out, 350);
        assert.deepStrictEqual(claim.resumeState.children_tokens_in, {
          [childId]: 300,
        });
      } finally {
        await prisma.agent.deleteMany({ where: { id: childId } });
      }
    });
  });

  await test('iteration recovery uses the workflow checkpoint instead of provider attempts', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: agentId, workflowIterationOffset: 11 },
      });
      await prisma.toolUsage.createMany({
        data: [1, 2, 2, 3].map((iteration) => ({
          agentId,
          userId: `workflow-restart-unit-${agentId}`,
          toolName: 'execute_loop',
          totalCostCents: 0,
          usageItems: [{ iteration }],
        })),
      });

      const claim = await claimWorkflowReplacement(agentId);
      assert.strictEqual(claim.resumeState.iteration_offset, 11);
    });
  });

  await test('a failed fresh start stays resumable and never exposes ACTIVE', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: agentId },
      });
      const claim = await claimWorkflowReplacement(agentId);
      await markWorkflowReplacementFailed(claim, new Error('candidate unavailable'));

      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const resumed = await claimWorkflowReplacement(agentId);
      assert.strictEqual(stored.status, 'STARTING_UP');
      assert.match(stored.statusMessage ?? '', /candidate unavailable/);
      assert.strictEqual(stored.temporalWorkflowId, claim.plannedWorkflowId);
      assert.deepStrictEqual(stored.workflowReplacementState, claim.resumeState);
      assert.strictEqual(resumed.token, claim.token);
      assert.deepStrictEqual(resumed.resumeState, claim.resumeState);
    });
  });

  await test('no-worker and first-task retries reuse paused, cost, and approval snapshots', async () => {
    const cases = [
      { name: 'paused/no-worker', status: 'PAUSED' as const, failedFirstTask: false },
      {
        name: 'cost-limited/first-task-failure',
        status: 'COST_LIMIT_REACHED' as const,
        failedFirstTask: true,
      },
      { name: 'awaiting-approval/no-worker', status: 'PAUSED' as const, failedFirstTask: false },
    ];
    for (const testCase of cases) {
      await withAgent(async (agentId) => {
        const staleWorkflowId = `${agentId}:stale`;
        await prisma.agent.update({
          where: { id: agentId },
          data: {
            temporalWorkflowId: staleWorkflowId,
            status: testCase.status,
            statusMessage: testCase.name,
            tokenCount: 777,
            tokensIn: 555,
            tokensOut: 222,
            workflowIterationOffset: 9,
          },
        });
        if (testCase.name.startsWith('awaiting-approval')) {
          await prisma.agentAttentionRequest.create({
            data: {
              userId: `workflow-replacement-state-unit-${agentId}`,
              agentId,
              workflowId: staleWorkflowId,
              question: 'Approve the pending action?',
            },
          });
        }

        const first = await claimWorkflowReplacement(agentId);
        await recordWorkflowReplacementStartAcceptance(first, {
          workflowId: first.plannedWorkflowId,
          firstExecutionRunId: `${testCase.name}:run-1`,
        });
        if (testCase.failedFirstTask) {
          await prisma.agent.update({
            where: { id: agentId },
            data: { status: 'FAILED', statusMessage: 'candidate failed its first task' },
          });
        }

        const retried = await claimWorkflowReplacement(agentId);
        assert.strictEqual(retried.token, first.token, testCase.name);
        assert.strictEqual(retried.plannedWorkflowId, first.plannedWorkflowId, testCase.name);
        assert.deepStrictEqual(retried.resumeState, first.resumeState, testCase.name);
        assert.strictEqual(retried.resumeState.prior_status, testCase.status, testCase.name);
        assert.strictEqual(retried.resumeState.token_count, 777, testCase.name);
        assert.strictEqual(retried.resumeState.iteration_offset, 9, testCase.name);

        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(stored.workflowReplacementToken, first.token, testCase.name);
        assert.deepStrictEqual(stored.workflowReplacementState, first.resumeState, testCase.name);
        await prisma.agentAttentionRequest.deleteMany({ where: { agentId } });
      });
    }
  });

  await test('bootstrap acknowledgement is generation-fenced, idempotent, and consumes the claim', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: `${agentId}:stale`, status: 'PAUSED' },
      });
      const claim = await claimWorkflowReplacement(agentId);
      await recordWorkflowReplacementStartAcceptance(claim, {
        workflowId: claim.plannedWorkflowId,
        firstExecutionRunId: 'candidate-run',
      });

      assert.strictEqual(
        await acknowledgeWorkflowReplacementBootstrap(agentId, `${agentId}:stale`),
        'stale_generation'
      );
      let stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.workflowReplacementToken, claim.token);
      assert.deepStrictEqual(stored.workflowReplacementState, claim.resumeState);

      assert.strictEqual(
        await acknowledgeWorkflowReplacementBootstrap(agentId, claim.plannedWorkflowId),
        'acknowledged'
      );
      stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.workflowReplacementToken, null);
      assert.strictEqual(stored.workflowReplacementState, null);
      assert.strictEqual(stored.staleTemporalWorkflowId, null);
      assert.strictEqual(stored.temporalWorkflowId, claim.plannedWorkflowId);
      assert.strictEqual(stored.temporalFirstExecutionRunId, 'candidate-run');

      assert.strictEqual(
        await acknowledgeWorkflowReplacementBootstrap(agentId, claim.plannedWorkflowId),
        'already_acknowledged'
      );
    });
  });

  await test('control state committed after fetch wins atomic bootstrap finalization', async () => {
    for (const status of ['PAUSED', 'COST_LIMIT_REACHED', 'OUT_OF_CREDITS', 'ACTIVE'] as const) {
      await withAgent(async (agentId) => {
        await prisma.agent.update({
          where: { id: agentId },
          data: { temporalWorkflowId: `${agentId}:stale`, status: 'ACTIVE' },
        });
        const claim = await claimWorkflowReplacement(agentId);
        await prisma.agent.update({
          where: { id: agentId },
          data: { status, statusMessage: `newer ${status}` },
        });

        const finalized = await finalizeWorkflowReplacementBootstrap(
          agentId,
          claim.plannedWorkflowId,
          {
            status: 'ACTIVE',
            statusMessage: 'stale fetched ACTIVE',
            progress: 0.6,
            tokenCount: 123,
            tokensIn: 80,
            tokensOut: 43,
            contextSize: 456,
            messageCount: 7,
            iterationOffset: 12,
          }
        );
        assert.strictEqual(finalized.outcome, 'acknowledged');
        assert.strictEqual(finalized.status, status);
        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(stored.status, status);
        assert.strictEqual(stored.statusMessage, `newer ${status}`);
        assert.strictEqual(stored.tokenCount, 123);
        assert.strictEqual(stored.workflowIterationOffset, 12);
        assert.strictEqual(stored.workflowReplacementToken, null);
      });
    }
  });

  await test('start acceptance still records the chain if bootstrap acknowledgement wins the race', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: `${agentId}:stale`, status: 'PAUSED' },
      });
      const claim = await claimWorkflowReplacement(agentId);
      assert.strictEqual(
        await acknowledgeWorkflowReplacementBootstrap(agentId, claim.plannedWorkflowId),
        'acknowledged'
      );
      assert.strictEqual(
        await recordWorkflowReplacementStartAcceptance(claim, {
          workflowId: claim.plannedWorkflowId,
          firstExecutionRunId: 'candidate-race-run',
        }),
        true
      );
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.workflowReplacementToken, null);
      assert.strictEqual(stored.temporalFirstExecutionRunId, 'candidate-race-run');
    });
  });

  await test('post-start bookkeeping failure cannot overwrite a restored pause state', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: agentId, status: 'PAUSED' },
      });
      const claim = await claimWorkflowReplacement(agentId);
      await prisma.agent.update({
        where: { id: agentId },
        data: { status: 'PAUSED', statusMessage: 'Paused by replacement workflow' },
      });
      await markWorkflowReplacementFailed(claim, new Error('completion write timed out'));

      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.status, 'PAUSED');
      assert.match(stored.statusMessage ?? '', /completion write timed out/);
      assert.deepStrictEqual(stored.workflowReplacementState, claim.resumeState);
    });
  });

  await test('a stale workflow cannot overwrite replacement status after the cutover claim', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: agentId },
      });
      const claim = await claimWorkflowReplacement(agentId);

      const returned = await updateAgentStatus(
        agentId,
        {
          status: 'FAILED',
          statusMessage: 'late failure from old workflow',
          progress: 1,
          tokenCount: 100,
          tokensIn: 60,
          tokensOut: 40,
          contextSize: 50,
          messageCount: 10,
        },
        {},
        agentId
      );
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

      assert(returned);
      assert.strictEqual(stored.temporalWorkflowId, claim.plannedWorkflowId);
      assert.strictEqual(stored.status, 'STARTING_UP');
      assert.strictEqual(stored.statusMessage, 'Updating agent code');
    });
  });

  await test('current replacement can resume cold states but never irreversible states', async () => {
    await withAgent(async (agentId) => {
      const workflowId = `${agentId}:replacement:current`;
      for (const coldStatus of ['COST_LIMIT_REACHED', 'OUT_OF_CREDITS'] as const) {
        await prisma.agent.update({
          where: { id: agentId },
          data: { temporalWorkflowId: workflowId, status: coldStatus },
        });
        await updateAgentStatus(
          agentId,
          {
            status: 'ACTIVE',
            statusMessage: 'Resume accepted by current workflow',
            progress: 0.5,
            tokenCount: 100,
            tokensIn: 60,
            tokensOut: 40,
            contextSize: 50,
            messageCount: 10,
          },
          {},
          workflowId
        );
        const resumed = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(resumed.status, 'ACTIVE');
      }

      await prisma.agent.update({
        where: { id: agentId },
        data: { status: 'FAILED', statusMessage: 'Irreversible failure' },
      });
      await updateAgentStatus(
        agentId,
        {
          status: 'ACTIVE',
          statusMessage: 'Late stale resume',
          progress: 0.5,
          tokenCount: 100,
          tokensIn: 60,
          tokensOut: 40,
          contextSize: 50,
          messageCount: 10,
        },
        {},
        workflowId
      );
      const failed = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(failed.status, 'FAILED');
      assert.strictEqual(failed.statusMessage, 'Irreversible failure');
    });
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
