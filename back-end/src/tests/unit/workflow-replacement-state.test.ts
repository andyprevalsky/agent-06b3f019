#!/usr/bin/env tsx
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  acknowledgeWorkflowReplacementBootstrap,
  claimWorkflowReplacement,
  recordWorkflowReplacementStartAcceptance,
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

  await test('legacy retries preserve the exact durable billed ledger', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          temporalWorkflowId: agentId,
          tokenCount: 950,
          tokensIn: 680,
          tokensOut: 270,
          ownCostCents: 17.25,
        },
      });
      await prisma.toolUsage.createMany({
        data: Array.from({ length: 3 }, () => ({
          agentId,
          userId: `workflow-replacement-state-unit-${agentId}`,
          toolName: 'execute_loop',
          totalCostCents: 900,
          usageItems: [{ type: 'llm', tokens_in: 500, tokens_out: 500, cost_cents: 900 }],
        })),
      });

      const claim = await claimWorkflowReplacement(agentId);
      assert.strictEqual(claim.resumeState.token_count, 3_000);
      assert.strictEqual(claim.resumeState.tokens_in, 1_500);
      assert.strictEqual(claim.resumeState.tokens_out, 1_500);
      assert.strictEqual(claim.resumeState.own_cost_cents, 2_700);
    });
  });

  await test('idempotent usage checkpoint closes an unfinished Agent debounce window', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          temporalWorkflowId: agentId,
          tokenCount: 950,
          tokensIn: 680,
          tokensOut: 270,
          ownCostCents: 17.25,
        },
      });
      await prisma.toolUsage.create({
        data: {
          operationKey: `${agentId}:usage-checkpoint`,
          agentId,
          userId: `workflow-replacement-state-unit-${agentId}`,
          toolName: 'execute_loop',
          totalCostCents: 2,
          usageItems: [{ type: 'llm', tokens_in: 50, tokens_out: 25, cost_cents: 2 }],
          tokenCountCheckpoint: 1_025,
          tokensInCheckpoint: 730,
          tokensOutCheckpoint: 295,
          ownCostCheckpointCents: 19.25,
        },
      });

      const claim = await claimWorkflowReplacement(agentId);
      assert.strictEqual(claim.resumeState.token_count, 1_025);
      assert.strictEqual(claim.resumeState.tokens_in, 730);
      assert.strictEqual(claim.resumeState.tokens_out, 295);
      assert.strictEqual(claim.resumeState.own_cost_cents, 19.25);
    });
  });

  await test('expected workflow claims atomically skip advanced generations and coalesce retries', async () => {
    await withAgent(async (agentId) => {
      const frozenWorkflowId = `${agentId}:frozen`;
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: frozenWorkflowId },
      });

      const first = await claimWorkflowReplacement(agentId, undefined, {
        expectedWorkflowId: frozenWorkflowId,
      });
      assert(!('skipped' in first));
      const retried = await claimWorkflowReplacement(agentId, undefined, {
        expectedWorkflowId: frozenWorkflowId,
      });
      assert(!('skipped' in retried));
      assert.strictEqual(retried.token, first.token);
      assert.strictEqual(retried.plannedWorkflowId, first.plannedWorkflowId);

      const wrongGeneration = await claimWorkflowReplacement(agentId, undefined, {
        expectedWorkflowId: `${agentId}:different`,
      });
      assert('skipped' in wrongGeneration);
      assert.strictEqual(wrongGeneration.currentWorkflowId, first.plannedWorkflowId);
      assert.strictEqual(wrongGeneration.frozenWorkflowId, frozenWorkflowId);

      assert.strictEqual(
        await acknowledgeWorkflowReplacementBootstrap(agentId, first.plannedWorkflowId),
        'acknowledged'
      );
      const alreadyAdvanced = await claimWorkflowReplacement(agentId, undefined, {
        expectedWorkflowId: frozenWorkflowId,
      });
      assert('skipped' in alreadyAdvanced);
      assert.strictEqual(alreadyAdvanced.currentWorkflowId, first.plannedWorkflowId);
      assert.strictEqual(alreadyAdvanced.frozenWorkflowId, null);
    });
  });

  await test('completed or failed root wins snapshot-to-claim race', async () => {
    for (const status of ['COMPLETED', 'FAILED'] as const) {
      await withAgent(async (agentId) => {
        const workflowId = `${agentId}:${status.toLowerCase()}`;
        await prisma.agent.update({
          where: { id: agentId },
          data: { temporalWorkflowId: workflowId, status },
        });
        const result = await claimWorkflowReplacement(agentId, undefined, {
          expectedWorkflowId: workflowId,
        });
        assert('skipped' in result);
        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(stored.status, status);
        assert.strictEqual(stored.temporalWorkflowId, workflowId);
        assert.strictEqual(stored.workflowReplacementToken, null);
      });
    }
  });

  await test('deleted root wins snapshot-to-claim race', async () => {
    await withAgent(async (agentId) => {
      const workflowId = `${agentId}:deleted`;
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: workflowId, deletedAt: new Date() },
      });
      const result = await claimWorkflowReplacement(agentId, undefined, {
        expectedWorkflowId: workflowId,
      });
      assert('skipped' in result);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert(stored.deletedAt instanceof Date);
      assert.strictEqual(stored.workflowReplacementToken, null);
    });
  });

  await test('replacement state survives claim retries and start acceptance never forces ACTIVE', async () => {
    await withAgent(async (agentId) => {
      const childId = randomUUID();
      const grandchildId = randomUUID();
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
          workflowIterationOffset: 6,
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
          parentWorkflowId: agentId,
          depth: 1,
          temporalWorkflowId: childId,
          tokenCount: 300,
          tokensIn: 220,
          tokensOut: 80,
          treeCostCents: 12,
        },
      });
      await prisma.agent.create({
        data: {
          id: grandchildId,
          userId: `workflow-restart-unit-${agentId}`,
          goal: 'grandchild accounting state',
          status: 'PAUSED',
          busId: agentId,
          parentAgentId: childId,
          parentWorkflowId: childId,
          depth: 2,
          temporalWorkflowId: grandchildId,
          tokenCount: 70,
          tokensIn: 50,
          tokensOut: 20,
          // The direct child's persisted treeCostCents already includes this.
          treeCostCents: 4,
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
      await prisma.message.createMany({
        data: [
          {
            agentId: childId,
            workflowGeneration: childId,
            text: '',
            role: 'TOOL',
            metadata: {
              toolCallId: 'search-1',
              toolName: 'web_search',
              toolStatus: 'IN_PROGRESS',
            },
          },
          {
            agentId: childId,
            workflowGeneration: childId,
            text: 'found it',
            role: 'TOOL',
            metadata: {
              toolCallId: 'search-1',
              toolName: 'web_search',
              toolStatus: 'FINISHED',
            },
          },
          {
            agentId: childId,
            workflowGeneration: childId,
            text: 'duplicate terminal delivery',
            role: 'TOOL',
            metadata: {
              toolCallId: 'search-1',
              toolName: 'web_search',
              toolStatus: 'FINISHED',
            },
          },
          {
            agentId: childId,
            workflowGeneration: childId,
            text: 'failed',
            role: 'TOOL',
            metadata: {
              toolCallId: 'fetch-1',
              toolName: 'web_fetch',
              toolStatus: 'ERROR',
            },
          },
          {
            agentId: childId,
            workflowGeneration: childId,
            text: '',
            role: 'TOOL',
            metadata: {
              toolCallId: 'unfinished-1',
              toolName: 'browser_use',
              toolStatus: 'IN_PROGRESS',
            },
          },
          {
            agentId: grandchildId,
            workflowGeneration: grandchildId,
            text: 'grandchild finished',
            role: 'TOOL',
            metadata: {
              toolCallId: 'grandchild-browser-1',
              toolName: 'browser_use',
              toolStatus: 'FINISHED',
            },
          },
          ...[
            'completion_summary',
            'attempt_completion',
            'request_user_approval',
            'request_user_signup',
          ].map((toolName) => ({
            agentId: childId,
            workflowGeneration: childId,
            text: `${toolName} finished`,
            role: 'TOOL' as const,
            metadata: {
              toolCallId: `${toolName}-1`,
              toolName,
              toolStatus: 'FINISHED',
            },
          })),
          {
            agentId: childId,
            workflowGeneration: childId,
            text: 'verifier feedback',
            role: 'TOOL',
            metadata: {
              toolCallId: 'verifier-1',
              toolName: 'web_search',
              toolStatus: 'FINISHED',
              verifierMessage: true,
            },
          },
          {
            agentId: childId,
            workflowGeneration: childId,
            text: 'lowercase durable row',
            role: 'TOOL',
            metadata: {
              toolCallId: 'lowercase-1',
              toolName: 'web_fetch',
              toolStatus: 'finished',
            },
          },
        ],
      });

      try {
        const createdAt = (
          await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
        ).createdAt.toISOString();
        const first = await claimWorkflowReplacement(agentId);
        const retried = await claimWorkflowReplacement(agentId);
        assert.deepStrictEqual(retried.resumeState, first.resumeState);
        assert.deepStrictEqual(first.resumeState, {
          version: 1,
          kind: 'deployment',
          prior_status: 'PAUSED',
          prior_status_message: 'Paused by user',
          progress: 0.4,
          token_count: 1_250,
          tokens_in: 680,
          tokens_out: 270,
          tree_tokens_in: 900,
          tree_tokens_out: 350,
          context_size: 42_000,
          message_count: 73,
          workflow_started_at: createdAt,
          own_cost_cents: 17.25,
          subtree_cost_cents: 29.25,
          children_cost_cents: { [childId]: 12 },
          children_tokens_in: { [childId]: 220 },
          children_tokens_out: { [childId]: 80 },
          child_last_tokens: {
            [childId]: { tokens_in: 220, tokens_out: 80, token_count: 370 },
          },
          child_tool_counts: { web_search: 1, browser_use: 1 },
          iteration_offset: 6,
          max_iterations: 37,
          context_gates: { network: false, recent_communications: true },
        });

        await prisma.agent.update({ where: { id: agentId }, data: { status: 'PAUSED' } });
        await recordWorkflowReplacementStartAcceptance(first, {
          workflowId: first.plannedWorkflowId,
          firstExecutionRunId: 'replacement-run',
        });
        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(stored.status, 'PAUSED');
        assert.deepStrictEqual(stored.workflowReplacementState, first.resumeState);
        assert.strictEqual(stored.workflowReplacementToken, first.token);
      } finally {
        await prisma.agent.deleteMany({
          where: { id: { in: [childId, grandchildId] } },
        });
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
      workflow_started_at: '2026-01-01T00:00:00.000Z',
      own_cost_cents: 100,
      subtree_cost_cents: 100,
      children_cost_cents: {},
      children_tokens_in: {},
      children_tokens_out: {},
      child_last_tokens: {},
      child_tool_counts: {},
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

    const simulated = buildAgentWorkflowArgs({
      ...base,
      worldModelMode: 'simulate',
    });
    assert.strictEqual(simulated.length, 18);
    assert.strictEqual(simulated[16], null);
    assert.strictEqual(simulated[17], 'simulate');

    const simulatedReplacement = buildAgentWorkflowArgs({
      ...base,
      startPhase: 'resume',
      resumeState,
      worldModelMode: 'simulate',
    });
    assert.strictEqual(simulatedReplacement.length, 18);
    assert.strictEqual(simulatedReplacement[16], resumeState);
    assert.strictEqual(simulatedReplacement[17], 'simulate');
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
