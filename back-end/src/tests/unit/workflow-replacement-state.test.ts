#!/usr/bin/env tsx
/* eslint-disable max-lines */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { updateAgentStatus } from '../../domains/agents/agentControlService';
import { prisma } from '../../providers/database';
import {
  acknowledgeWorkflowReplacementBootstrap,
  claimWorkflowReplacement,
  markWorkflowReplacementFailed,
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
          tokens_in: 900,
          tokens_out: 350,
          tree_tokens_in: 1_170,
          tree_tokens_out: 450,
          context_size: 42_000,
          message_count: 73,
          own_cost_cents: 17.25,
          subtree_cost_cents: 29.25,
          children_cost_cents: { [childId]: 12 },
          children_tokens_in: { [childId]: 270 },
          children_tokens_out: { [childId]: 100 },
          child_last_tokens: {
            [childId]: { tokens_in: 270, tokens_out: 100, token_count: 370 },
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
        assert.strictEqual(claim.resumeState.token_count, 1_250);
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
