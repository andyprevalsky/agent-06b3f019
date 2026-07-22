#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { updateAgentStatus } from '../../domains/agents/agentControlService';
import { prisma } from '../../providers/database';
import {
  claimWorkflowReplacement,
  completeWorkflowReplacement,
  markWorkflowReplacementFailed,
} from '../../providers/workflowReplacementState';
import {
  buildAgentWorkflowArgs,
  buildAgentWorkflowStartHistoryRequest,
  parseAgentWorkflowLaunchConfig,
} from '../../providers/temporal';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow replacement state unit tests');

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
  await test('concurrent replacement claims coalesce onto one durable generation', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: agentId },
      });
      const claims = await Promise.all(
        Array.from({ length: 12 }, () => claimWorkflowReplacement(agentId))
      );
      assert.strictEqual(new Set(claims.map((claim) => claim.token)).size, 1);
      assert.strictEqual(new Set(claims.map((claim) => claim.plannedWorkflowId)).size, 1);

      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.workflowReplacementToken, claims[0].token);
      assert.strictEqual(stored.temporalWorkflowId, claims[0].plannedWorkflowId);
      assert.strictEqual(stored.staleTemporalWorkflowId, agentId);
    });
  });

  await test('replacement state survives claim retries and completion never forces ACTIVE', async () => {
    await withAgent(async (agentId) => {
      const childId = randomUUID();
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          temporalWorkflowId: agentId,
          status: 'PAUSED',
          statusMessage: 'Paused by user',
          progress: 0.4,
          tokenCount: 1_250,
          tokensIn: 900,
          tokensOut: 350,
          contextSize: 42_000,
          messageCount: 73,
          ownCostCents: 17.25,
          treeCostCents: 29,
          workflowMaxIterations: 37,
          workflowContextGates: {
            network: false,
            recent_communications: true,
          },
        },
      });
      await prisma.agent.create({
        data: {
          id: childId,
          userId: `workflow-restart-unit-${agentId}`,
          goal: 'child accounting state',
          status: 'PAUSED',
          busId: agentId,
          parentAgentId: agentId,
          temporalWorkflowId: childId,
          tokenCount: 300,
          tokensIn: 220,
          tokensOut: 80,
          treeCostCents: 12,
        },
      });
      await prisma.toolUsage.createMany({
        data: Array.from({ length: 6 }, () => ({
          agentId,
          userId: `workflow-restart-unit-${agentId}`,
          toolName: 'execute_loop',
          totalCostCents: 0,
          usageItems: [],
        })),
      });

      try {
        const first = await claimWorkflowReplacement(agentId);
        const retried = await claimWorkflowReplacement(agentId);
        assert.deepStrictEqual(retried.resumeState, first.resumeState);
        assert.deepStrictEqual(first.resumeState, {
          version: 1,
          kind: 'deployment',
          prior_status: 'PAUSED',
          prior_status_message: 'Paused by user',
          progress: 0.4,
          token_count: 950,
          tokens_in: 680,
          tokens_out: 270,
          tree_tokens_in: 900,
          tree_tokens_out: 350,
          context_size: 42_000,
          message_count: 73,
          own_cost_cents: 17.25,
          subtree_cost_cents: 29,
          children_cost_cents: { [childId]: 12 },
          children_tokens_in: { [childId]: 220 },
          children_tokens_out: { [childId]: 80 },
          child_last_tokens: {
            [childId]: { tokens_in: 220, tokens_out: 80, token_count: 300 },
          },
          iteration_offset: 6,
          max_iterations: 37,
          context_gates: { network: false, recent_communications: true },
        });

        await prisma.agent.update({ where: { id: agentId }, data: { status: 'PAUSED' } });
        await completeWorkflowReplacement(first, {
          workflowId: first.plannedWorkflowId,
          firstExecutionRunId: 'replacement-run',
        });
        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(stored.status, 'PAUSED');
        assert.strictEqual(stored.workflowReplacementState, null);
      } finally {
        await prisma.agent.deleteMany({ where: { id: childId } });
      }
    });
  });

  await test('ordinary workflow starts stay backwards-compatible while replacements carry state', async () => {
    const base = {
      agentId: 'agent-1',
      userId: 'user-1',
      goal: 'continue safely',
      model: 'rose-labs/rose-1-ultra',
      reasoningMaxTokens: 2048,
      verifier: { type: 'FLOAT_LLM_JUDGE' },
    };
    const ordinary = buildAgentWorkflowArgs(base);
    assert.strictEqual(ordinary.length, 16);
    assert.strictEqual(ordinary[11], 'plan');

    const resumeState = {
      version: 1 as const,
      kind: 'deployment' as const,
      prior_status: 'COST_LIMIT_REACHED' as const,
      prior_status_message: 'Cost limit reached',
      progress: 0.5,
      token_count: 10,
      tokens_in: 6,
      tokens_out: 4,
      tree_tokens_in: 6,
      tree_tokens_out: 4,
      context_size: 100,
      message_count: 8,
      own_cost_cents: 100,
      subtree_cost_cents: 100,
      children_cost_cents: {},
      children_tokens_in: {},
      children_tokens_out: {},
      child_last_tokens: {},
      iteration_offset: 3,
      max_iterations: 20,
      context_gates: { network: false },
    };
    const replacement = buildAgentWorkflowArgs({
      ...base,
      startPhase: 'resume',
      maxIterations: 20,
      contextGates: { network: false },
      resumeState,
    });
    assert.strictEqual(replacement.length, 17);
    assert.strictEqual(replacement[11], 'resume');
    assert.strictEqual(replacement[12], 20);
    assert.deepStrictEqual(replacement[14], { network: false });
    assert.strictEqual(replacement[16], resumeState);
  });

  await test('historical workflow inputs recover deploy-critical configuration without replay', async () => {
    assert.deepStrictEqual(buildAgentWorkflowStartHistoryRequest('prod', 'workflow-1'), {
      namespace: 'prod',
      execution: { workflowId: 'workflow-1' },
      maximumPageSize: 1,
      waitNewEvent: false,
      skipArchival: true,
    });
    const gates = { network: false, integrations: true };
    const config = parseAgentWorkflowLaunchConfig([
      'agent-1',
      'user-1',
      'goal',
      'model',
      2048,
      { type: 'FLOAT_LLM_JUDGE' },
      [],
      null,
      null,
      0,
      null,
      'execute_continued',
      25,
      100,
      gates,
      false,
    ]);
    assert.deepStrictEqual(config, { maxIterations: 25, contextGates: gates });

    assert.deepStrictEqual(parseAgentWorkflowLaunchConfig(['legacy']), {
      maxIterations: null,
      contextGates: null,
    });
    assert.throws(
      () =>
        parseAgentWorkflowLaunchConfig([
          ...Array.from({ length: 12 }, () => null),
          'not-an-integer',
        ]),
      /max iterations/
    );
  });

  await test('a legacy launch config is atomically cemented into the replacement snapshot', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          temporalWorkflowId: agentId,
          workflowMaxIterations: null,
          workflowContextGates: Prisma.DbNull,
        },
      });
      const config = {
        maxIterations: 31,
        contextGates: { network: false, shared_files: true },
      };

      const claim = await claimWorkflowReplacement(agentId, config);
      assert.strictEqual(claim.resumeState.max_iterations, 31);
      assert.deepStrictEqual(claim.resumeState.context_gates, config.contextGates);

      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.workflowMaxIterations, 31);
      assert.deepStrictEqual(stored.workflowContextGates, config.contextGates);
    });
  });

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
        assert.strictEqual(claim.resumeState.token_count, 950);
      } finally {
        await prisma.agent.deleteMany({ where: { id: childId } });
      }
    });
  });

  await test('iteration recovery uses durable positions instead of counting retry billing rows', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: agentId },
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
      assert.strictEqual(claim.resumeState.iteration_offset, 3);
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
