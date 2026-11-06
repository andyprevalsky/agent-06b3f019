#!/usr/bin/env tsx

import assert from 'node:assert';
import { testJevProgressEstimates } from './agent-progress-estimate.cases';
import { randomUUID } from 'node:crypto';
import { updateAgentConfig } from '../../domains/agents/agentConfigService';
import * as agentRepo from '../../domains/agents/repo';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { claimWorkflowReplacement } from '../../providers/workflowReplacementState';
import { testAgentControlIntentCases } from './agent-control-intent.cases';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('agent generation mutation fence unit tests');

async function createAgent(): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `agent-generation-mutations-${id}`,
      goal: 'test stale workflow mutation fencing',
      temporalWorkflowId: id,
      status: 'ACTIVE',
      progress: 0.2,
      messageCount: 4,
      toolsInUse: ['old-tool'],
      treeCostCents: 30,
      ownCostCents: 12,
      responseSchema: {
        fields: [{ name: 'original', type: 'str' }],
      },
    },
  });
  return id;
}

async function createTool(label: string): Promise<string> {
  const tool = await prisma.tool.create({
    data: { name: `${label}-${randomUUID()}` },
  });
  return tool.id;
}

async function main(): Promise<void> {
  await test('a sealed generation rejects every late shared agent mutation', async () => {
    const agentId = await createAgent();
    const replacementGeneration = `${agentId}:replacement:${randomUUID()}`;
    let releaseSeal = () => {};
    let announceSeal = () => {};
    const sealAcquired = new Promise<void>((resolve) => {
      announceSeal = resolve;
    });
    const sealRelease = new Promise<void>((resolve) => {
      releaseSeal = resolve;
    });

    try {
      const sealing = runTransactionWithRetry(async (tx) => {
        await lockAgentWorkflowGeneration(tx, agentId);
        announceSeal();
        await sealRelease;
        await tx.agent.update({
          where: { id: agentId },
          data: {
            temporalWorkflowId: replacementGeneration,
            status: 'PAUSED',
            progress: 0.6,
            messageCount: 11,
            toolsInUse: ['restored-tool'],
            treeCostCents: 80,
            ownCostCents: 45,
            responseSchema: {
              fields: [{ name: 'restored', type: 'str' }],
            },
          },
        });
      });
      await sealAcquired;

      let staleSettled = false;
      const staleMutation = updateAgentConfig(
        agentId,
        {
          status: 'FAILED',
          progress: 1,
          message_count: 999,
          tools_in_use: ['stale-tool'],
          tree_cost_cents: 1,
          own_cost_cents: 1,
          response_schema: {
            fields: [{ name: 'stale', type: 'str' }],
          },
        },
        undefined,
        agentId
      ).finally(() => {
        staleSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(
        staleSettled,
        false,
        'stale mutation must wait behind the generation cutover lock'
      );
      releaseSeal();
      const [, staleResult] = await Promise.all([sealing, staleMutation]);
      assert.strictEqual(staleResult.mutation_accepted, false);

      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.temporalWorkflowId, replacementGeneration);
      assert.strictEqual(stored.status, 'PAUSED');
      assert.strictEqual(stored.progress, 0.6);
      assert.strictEqual(stored.messageCount, 11);
      assert.deepStrictEqual(stored.toolsInUse, ['restored-tool']);
      assert.strictEqual(stored.treeCostCents, 80);
      assert.strictEqual(stored.ownCostCents, 45);
      assert.deepStrictEqual(stored.responseSchema, {
        fields: [{ name: 'restored', type: 'str' }],
      });
    } finally {
      releaseSeal();
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('the current generation can update restored state and accounting', async () => {
    const agentId = await createAgent();
    const replacementGeneration = `${agentId}:replacement:${randomUUID()}`;
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          temporalWorkflowId: replacementGeneration,
          status: 'PAUSED',
        },
      });

      await updateAgentConfig(
        agentId,
        {
          status: 'ACTIVE',
          progress: 0.8,
          message_count: 12,
          tools_in_use: ['current-tool'],
          response_schema: {
            fields: [{ name: 'current', type: 'str' }],
          },
        },
        undefined,
        replacementGeneration
      );
      const accountingAccepted = await agentRepo.updateAgentForWorkflow(
        agentId,
        replacementGeneration,
        {
          treeCostCents: 95,
          ownCostCents: 52,
        }
      );

      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(accountingAccepted.accepted, true);
      assert.strictEqual(accountingAccepted.agent?.ownCostCents, 52);
      assert.strictEqual(stored.status, 'ACTIVE');
      assert.strictEqual(stored.progress, 0.8);
      assert.strictEqual(stored.messageCount, 12);
      assert.deepStrictEqual(stored.toolsInUse, ['current-tool']);
      assert.strictEqual(stored.treeCostCents, 95);
      assert.strictEqual(stored.ownCostCents, 52);
      assert.deepStrictEqual(stored.responseSchema, {
        fields: [{ name: 'current', type: 'str' }],
      });
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await testAgentControlIntentCases(test, createAgent);

  await test('generated titles apply once to root agents without overwriting human renames', async () => {
    const rootAgentId = await createAgent();
    const childAgentId = await createAgent();
    const broadcasts: Array<{ agentId: string; title?: string | null }> = [];
    const dependencies = {
      broadcastUpdate: async (agentId: string, update: { title?: string | null }) => {
        broadcasts.push({ agentId, title: update.title });
      },
    };
    try {
      await prisma.agent.update({
        where: { id: childAgentId },
        data: { parentAgentId: rootAgentId },
      });

      const rootResult = await updateAgentConfig(
        rootAgentId,
        {
          generated_title: 'Generated Root Title',
          response_schema: { fields: [{ name: 'first', type: 'str', required: true }] },
        },
        undefined,
        rootAgentId,
        dependencies
      );
      assert.strictEqual(rootResult.mutation_accepted, true);
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: rootAgentId } })).title,
        'Generated Root Title'
      );
      assert.deepStrictEqual(broadcasts, [{ agentId: rootAgentId, title: 'Generated Root Title' }]);

      await updateAgentConfig(rootAgentId, { title: 'Human Rename' });
      await updateAgentConfig(
        rootAgentId,
        {
          generated_title: 'Later Generated Title',
          response_schema: { fields: [{ name: 'second', type: 'str', required: true }] },
        },
        undefined,
        rootAgentId,
        dependencies
      );
      const renamedRoot = await prisma.agent.findUniqueOrThrow({ where: { id: rootAgentId } });
      assert.strictEqual(renamedRoot.title, 'Human Rename');
      assert.deepStrictEqual(renamedRoot.responseSchema, {
        fields: [{ name: 'second', type: 'str', required: true }],
      });

      const childResult = await updateAgentConfig(
        childAgentId,
        {
          generated_title: 'Unused Child Title',
          response_schema: { fields: [{ name: 'child', type: 'str', required: true }] },
        },
        undefined,
        childAgentId,
        dependencies
      );
      assert.strictEqual(childResult.mutation_accepted, true);
      const child = await prisma.agent.findUniqueOrThrow({ where: { id: childAgentId } });
      assert.strictEqual(child.title, null);
      assert.deepStrictEqual(child.responseSchema, {
        fields: [{ name: 'child', type: 'str', required: true }],
      });
      assert.deepStrictEqual(broadcasts, [
        { agentId: rootAgentId, title: 'Generated Root Title' },
        { agentId: rootAgentId, title: 'Human Rename' },
      ]);
    } finally {
      await prisma.agent.update({
        where: { id: childAgentId },
        data: { parentAgentId: null },
      });
      await prisma.agent.deleteMany({ where: { id: { in: [rootAgentId, childAgentId] } } });
    }
  });

  await test('pause serializes with a replacement claim and targets the winning generation', async () => {
    const agentId = await createAgent();
    const replacementGeneration = `${agentId}:replacement:${randomUUID()}`;
    let releaseClaim = () => {};
    let announceClaim = () => {};
    const claimAcquired = new Promise<void>((resolve) => {
      announceClaim = resolve;
    });
    const claimRelease = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });

    try {
      const claiming = runTransactionWithRetry(async (tx) => {
        await lockAgentWorkflowGeneration(tx, agentId);
        announceClaim();
        await claimRelease;
        await tx.agent.update({
          where: { id: agentId },
          data: { temporalWorkflowId: replacementGeneration, status: 'STARTING_UP' },
        });
      });
      await claimAcquired;

      let pauseSettled = false;
      const pausing = agentRepo.pauseAgentUnderWorkflowLock(agentId).finally(() => {
        pauseSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(pauseSettled, false);

      releaseClaim();
      const [, paused] = await Promise.all([claiming, pausing]);
      assert(paused);
      assert.strictEqual(paused.paused, true);
      assert.strictEqual(paused.temporalWorkflowId, replacementGeneration);
      assert.strictEqual(
        (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).status,
        'PAUSED'
      );
    } finally {
      releaseClaim();
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('tool_ids-only and mixed config mutations use the same generation fence', async () => {
    const agentId = await createAgent();
    const originalToolId = await createTool('original-tool');
    const currentToolId = await createTool('current-tool');
    const staleToolId = await createTool('stale-tool');
    const replacementGeneration = `${agentId}:replacement:${randomUUID()}`;
    try {
      await prisma.agentTool.create({
        data: { agentId, toolId: originalToolId },
      });
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: replacementGeneration },
      });

      const staleOnly = await updateAgentConfig(
        agentId,
        { tool_ids: [staleToolId] },
        undefined,
        agentId
      );
      assert.strictEqual(staleOnly.mutation_accepted, false);

      const currentMixed = await updateAgentConfig(
        agentId,
        {
          tool_ids: [currentToolId],
          tools_in_use: ['current-runtime-tool'],
          progress: 0.7,
        },
        undefined,
        replacementGeneration
      );
      assert.strictEqual(currentMixed.mutation_accepted, true);

      const [stored, assignments] = await Promise.all([
        prisma.agent.findUniqueOrThrow({ where: { id: agentId } }),
        prisma.agentTool.findMany({ where: { agentId } }),
      ]);
      assert.deepStrictEqual(stored.toolsInUse, ['current-runtime-tool']);
      assert.strictEqual(stored.progress, 0.7);
      assert.deepStrictEqual(
        assignments.map((assignment) => assignment.toolId),
        [currentToolId]
      );
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
      await prisma.tool.deleteMany({
        where: { id: { in: [originalToolId, currentToolId, staleToolId] } },
      });
    }
  });

  await test('a cutover cannot split a tool replacement from its scalar config update', async () => {
    const agentId = await createAgent();
    const originalToolId = await createTool('race-original-tool');
    const staleToolId = await createTool('race-stale-tool');
    const replacementGeneration = `${agentId}:replacement:${randomUUID()}`;
    let releaseCutover = () => {};
    let announceCutover = () => {};
    const acquired = new Promise<void>((resolve) => {
      announceCutover = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCutover = resolve;
    });
    try {
      await prisma.agentTool.create({ data: { agentId, toolId: originalToolId } });
      const cutover = runTransactionWithRetry(async (tx) => {
        await lockAgentWorkflowGeneration(tx, agentId);
        announceCutover();
        await release;
        await tx.agent.update({
          where: { id: agentId },
          data: {
            temporalWorkflowId: replacementGeneration,
            toolsInUse: ['replacement-runtime-tool'],
          },
        });
      });
      await acquired;

      let settled = false;
      const staleMutation = updateAgentConfig(
        agentId,
        {
          tool_ids: [staleToolId],
          tools_in_use: ['stale-runtime-tool'],
        },
        undefined,
        agentId
      ).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(settled, false, 'config mutation must wait behind the cutover lock');
      releaseCutover();
      const [, result] = await Promise.all([cutover, staleMutation]);
      assert.strictEqual(result.mutation_accepted, false);

      const [stored, assignments] = await Promise.all([
        prisma.agent.findUniqueOrThrow({ where: { id: agentId } }),
        prisma.agentTool.findMany({ where: { agentId } }),
      ]);
      assert.deepStrictEqual(stored.toolsInUse, ['replacement-runtime-tool']);
      assert.deepStrictEqual(
        assignments.map((assignment) => assignment.toolId),
        [originalToolId]
      );
    } finally {
      releaseCutover();
      await prisma.agent.deleteMany({ where: { id: agentId } });
      await prisma.tool.deleteMany({ where: { id: { in: [originalToolId, staleToolId] } } });
    }
  });

  await test('stale price-limit config never signals the replacement workflow', async () => {
    const agentId = await createAgent();
    const replacementGeneration = `${agentId}:replacement:${randomUUID()}`;
    let signals = 0;
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: {
          temporalWorkflowId: replacementGeneration,
          status: 'COST_LIMIT_REACHED',
        },
      });
      const result = await updateAgentConfig(
        agentId,
        { price_limit_cents: 200 },
        undefined,
        agentId,
        {
          signalPriceLimit: async () => {
            signals += 1;
          },
        }
      );
      assert.strictEqual(result.mutation_accepted, false);
      assert.strictEqual(signals, 0);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.notStrictEqual(stored.priceLimitCents, 200);
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('a human price-limit raise serializes with cutover and signals the winner', async () => {
    const agentId = await createAgent();
    const replacementGeneration = `${agentId}:replacement:${randomUUID()}`;
    let releaseCutover = () => {};
    let announceCutover = () => {};
    const acquired = new Promise<void>((resolve) => {
      announceCutover = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCutover = resolve;
    });
    const signaled: Array<{ workflowId: string; limit: number }> = [];
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: { status: 'COST_LIMIT_REACHED' },
      });
      const cutover = runTransactionWithRetry(async (tx) => {
        await lockAgentWorkflowGeneration(tx, agentId);
        announceCutover();
        await release;
        await tx.agent.update({
          where: { id: agentId },
          data: { temporalWorkflowId: replacementGeneration },
        });
      });
      await acquired;

      let settled = false;
      const humanUpdate = updateAgentConfig(
        agentId,
        { price_limit_cents: 250 },
        undefined,
        undefined,
        {
          signalPriceLimit: async (workflowId, limit) => {
            signaled.push({ workflowId, limit });
          },
        }
      ).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(settled, false, 'human config must wait behind the cutover lock');
      releaseCutover();
      const [, result] = await Promise.all([cutover, humanUpdate]);
      assert.strictEqual(result.mutation_accepted, true);
      assert.deepStrictEqual(signaled, [{ workflowId: replacementGeneration, limit: 250 }]);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.priceLimitCents, 250);
    } finally {
      releaseCutover();
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('price-limit raise during a replacement claim durably resumes candidate', async () => {
    const agentId = await createAgent();
    const signals: Array<{ workflowId: string; limit: number }> = [];
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: { status: 'COST_LIMIT_REACHED', priceLimitCents: 100 },
      });
      await claimWorkflowReplacement(agentId);
      const result = await updateAgentConfig(
        agentId,
        { price_limit_cents: 250 },
        undefined,
        undefined,
        {
          signalPriceLimit: async (workflowId, limit) => {
            signals.push({ workflowId, limit });
          },
        }
      );
      assert.strictEqual(result.mutation_accepted, true);
      assert.deepStrictEqual(signals, []);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(stored.priceLimitCents, 250);
      assert.strictEqual(stored.status, 'ACTIVE');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test(
    'JEV predictions preserve ordering, terminal state, generation, and task identity',
    testJevProgressEstimates
  );

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
