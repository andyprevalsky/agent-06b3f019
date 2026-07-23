#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Message } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma } from '../../providers/database';
import { createMessage } from '../../providers/messages';
import {
  captureInProgressWorkflowTools,
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
} from '../../providers/staleWorkflowTools';
import { cleanupNonterminalDescendantWorkflows } from '../../providers/workflowDescendantCleanup';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow descendant cleanup unit tests');

interface TestTree {
  runId: string;
  rootId: string;
  childId: string;
  grandchildId: string;
  childWorkflowId: string;
  grandchildWorkflowId: string;
}

async function createTree(): Promise<TestTree> {
  const runId = `workflow-descendant-cleanup-${randomUUID()}`;
  const rootId = randomUUID();
  const childId = randomUUID();
  const grandchildId = randomUUID();
  const childWorkflowId = `${childId}:workflow`;
  const grandchildWorkflowId = `${grandchildId}:workflow`;
  const rootWorkflowId = `${rootId}:workflow`;
  await prisma.agent.createMany({
    data: [
      {
        id: rootId,
        userId: runId,
        goal: 'root',
        status: 'ACTIVE',
        busId: rootId,
        temporalWorkflowId: rootWorkflowId,
        temporalFirstExecutionRunId: `${rootId}:run`,
      },
      {
        id: childId,
        userId: runId,
        goal: 'child',
        status: 'ACTIVE',
        busId: rootId,
        parentAgentId: rootId,
        parentWorkflowId: rootWorkflowId,
        depth: 1,
        temporalWorkflowId: childWorkflowId,
        temporalFirstExecutionRunId: `${childId}:run`,
      },
      {
        id: grandchildId,
        userId: runId,
        goal: 'grandchild',
        status: 'PAUSED',
        busId: rootId,
        parentAgentId: childId,
        parentWorkflowId: childWorkflowId,
        depth: 2,
        temporalWorkflowId: grandchildWorkflowId,
        temporalFirstExecutionRunId: `${grandchildId}:run`,
      },
    ],
  });
  return { runId, rootId, childId, grandchildId, childWorkflowId, grandchildWorkflowId };
}

async function withTree(fn: (tree: TestTree) => Promise<void>): Promise<void> {
  const tree = await createTree();
  try {
    await fn(tree);
  } finally {
    await prisma.agent.deleteMany({ where: { userId: tree.runId } });
  }
}

async function postTool(
  agentId: string,
  workflowGeneration: string,
  toolCallId: string,
  status: string,
  extras: Record<string, unknown> = {}
): Promise<Message> {
  return createMessage({
    agentId,
    role: 'TOOL',
    text: `${status}:${toolCallId}`,
    metadata: {
      workflowGeneration,
      toolCallId,
      toolName: 'web_search',
      toolStatus: status,
      ...extras,
    },
    enforceCurrentWorkflowGeneration: true,
  });
}

async function toolMessages(agentId: string, toolCallId: string): Promise<Message[]> {
  return prisma.message.findMany({
    where: {
      agentId,
      role: 'TOOL',
      metadata: { path: ['toolCallId'], equals: toolCallId },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

function metadata(message: Message): Record<string, unknown> {
  assert(message.metadata !== null && !Array.isArray(message.metadata));
  return message.metadata as Record<string, unknown>;
}

async function main(): Promise<void> {
  await test('child and grandchild are sealed, terminated, finalized, and failed', async () => {
    await withTree(async (tree) => {
      const childToolCallId = randomUUID();
      const grandchildToolCallId = randomUUID();
      const approvalId = randomUUID();
      await postTool(tree.childId, tree.childWorkflowId, childToolCallId, 'IN_PROGRESS');
      await postTool(
        tree.grandchildId,
        tree.grandchildWorkflowId,
        grandchildToolCallId,
        'IN_PROGRESS',
        { attentionRequestId: approvalId }
      );
      await prisma.agentAttentionRequest.create({
        data: {
          id: approvalId,
          userId: tree.runId,
          agentId: tree.grandchildId,
          workflowId: tree.grandchildWorkflowId,
          question: 'Approve this?',
        },
      });

      const terminations: Array<{ workflowId: string; firstExecutionRunId: string }> = [];
      const result = await cleanupNonterminalDescendantWorkflows(tree.rootId, {
        terminate: async (execution, agentId) => {
          const sealed = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
          assert.notStrictEqual(sealed.temporalWorkflowId, execution.workflowId);
          assert.notStrictEqual(sealed.status, 'FAILED');
          terminations.push(execution);
        },
      });

      assert.deepStrictEqual(result, {
        discovered: 2,
        sealed: 2,
        skipped: 0,
        terminated: 2,
        interruptedTools: 2,
      });
      assert.deepStrictEqual(
        new Set(terminations.map((execution) => execution.workflowId)),
        new Set([tree.childWorkflowId, tree.grandchildWorkflowId])
      );
      for (const agentId of [tree.childId, tree.grandchildId]) {
        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(stored.status, 'FAILED');
        assert.strictEqual(stored.statusMessage, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
        assert.match(stored.temporalWorkflowId ?? '', /:deployment-sealed:/);
        assert.strictEqual(stored.staleTemporalWorkflowId, null);
      }
      const approval = await prisma.agentAttentionRequest.findUniqueOrThrow({
        where: { id: approvalId },
      });
      assert.strictEqual(approval.userResponse, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
    });
  });

  await test('success before the seal wins while success after the seal is fenced', async () => {
    await withTree(async (tree) => {
      await prisma.agent.update({
        where: { id: tree.grandchildId },
        data: { status: 'COMPLETED' },
      });
      const beforeCallId = randomUUID();
      await postTool(tree.childId, tree.childWorkflowId, beforeCallId, 'IN_PROGRESS');
      let postedBeforeSeal = false;
      await cleanupNonterminalDescendantWorkflows(tree.rootId, {
        captureInProgressTools: async (agentId, workflowGeneration) => {
          const captured = await captureInProgressWorkflowTools(agentId, workflowGeneration);
          if (!postedBeforeSeal) {
            postedBeforeSeal = true;
            await postTool(agentId, workflowGeneration, beforeCallId, 'FINISHED');
          }
          return captured;
        },
        terminate: async () => undefined,
      });
      const beforeRows = await toolMessages(tree.childId, beforeCallId);
      assert.strictEqual(
        beforeRows.filter((row) => metadata(row).errorCode === 'DEPLOY_INTERRUPTED').length,
        0
      );
      assert.strictEqual(
        beforeRows.filter((row) => metadata(row).toolStatus === 'FINISHED').length,
        1
      );
    });

    await withTree(async (tree) => {
      await prisma.agent.update({
        where: { id: tree.grandchildId },
        data: { status: 'COMPLETED' },
      });
      const afterCallId = randomUUID();
      await postTool(tree.childId, tree.childWorkflowId, afterCallId, 'IN_PROGRESS');
      await cleanupNonterminalDescendantWorkflows(tree.rootId, {
        terminate: async (_execution, agentId) => {
          await postTool(agentId, tree.childWorkflowId, afterCallId, 'FINISHED');
        },
      });
      const afterRows = await toolMessages(tree.childId, afterCallId);
      const terminals = afterRows.filter((row) => {
        const status = metadata(row).toolStatus;
        return typeof status === 'string' && status !== 'IN_PROGRESS';
      });
      assert.strictEqual(terminals.length, 1);
      assert.strictEqual(metadata(terminals[0]).errorCode, 'DEPLOY_INTERRUPTED');
      assert.strictEqual(terminals[0].text, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
    });
  });

  await test('an already-closed workflow is finalized without a termination call', async () => {
    await withTree(async (tree) => {
      await prisma.agent.update({
        where: { id: tree.grandchildId },
        data: { status: 'COMPLETED' },
      });
      await prisma.agent.update({
        where: { id: tree.childId },
        data: { temporalFirstExecutionRunId: null },
      });
      const toolCallId = randomUUID();
      await postTool(tree.childId, tree.childWorkflowId, toolCallId, 'IN_PROGRESS');
      let terminateCalls = 0;
      const result = await cleanupNonterminalDescendantWorkflows(tree.rootId, {
        resolveExecution: async (workflowId) => {
          throw new WorkflowNotFoundError('already closed', workflowId, undefined);
        },
        terminate: async () => {
          terminateCalls += 1;
        },
      });

      assert.strictEqual(result.sealed, 1);
      assert.strictEqual(result.terminated, 0);
      assert.strictEqual(terminateCalls, 0);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: tree.childId } });
      assert.strictEqual(stored.status, 'FAILED');
    });
  });

  await test('a descendant generation that advances before the seal is re-snapshotted and stopped', async () => {
    await withTree(async (tree) => {
      await prisma.agent.update({
        where: { id: tree.grandchildId },
        data: { status: 'COMPLETED' },
      });
      const advancedWorkflowId = `${tree.childId}:advanced`;
      let advanced = false;
      const terminatedWorkflowIds: string[] = [];
      const result = await cleanupNonterminalDescendantWorkflows(tree.rootId, {
        captureInProgressTools: async (agentId, workflowGeneration) => {
          const captured = await captureInProgressWorkflowTools(agentId, workflowGeneration);
          if (!advanced) {
            advanced = true;
            await prisma.agent.update({
              where: { id: agentId },
              data: {
                temporalWorkflowId: advancedWorkflowId,
                temporalFirstExecutionRunId: `${tree.childId}:advanced-run`,
              },
            });
          }
          return captured;
        },
        terminate: async (execution) => {
          terminatedWorkflowIds.push(execution.workflowId);
        },
      });

      assert.strictEqual(result.skipped, 0);
      assert.strictEqual(result.sealed, 1);
      assert.deepStrictEqual(terminatedWorkflowIds, [advancedWorkflowId]);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: tree.childId } });
      assert.match(stored.temporalWorkflowId ?? '', /:deployment-sealed:/);
      assert.strictEqual(stored.status, 'FAILED');
    });
  });

  await test('a descendant that never quiesces fails the root replacement instead of leaking', async () => {
    await withTree(async (tree) => {
      await prisma.agent.update({
        where: { id: tree.grandchildId },
        data: { status: 'COMPLETED' },
      });
      let generation = 0;
      await assert.rejects(
        cleanupNonterminalDescendantWorkflows(tree.rootId, {
          captureInProgressTools: async (agentId) => {
            generation += 1;
            await prisma.agent.update({
              where: { id: agentId },
              data: {
                temporalWorkflowId: `${agentId}:racing:${generation}`,
                temporalFirstExecutionRunId: `${agentId}:racing-run:${generation}`,
              },
            });
            return [];
          },
          terminate: async () => {
            throw new Error('A continuously advancing generation must never be terminated');
          },
        }),
        /did not quiesce after 5 attempts/
      );
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: tree.childId } });
      assert.strictEqual(stored.status, 'ACTIVE');
      assert.strictEqual(stored.temporalWorkflowId, `${tree.childId}:racing:5`);
    });
  });

  await test('a failed termination retains the durable seal and retries the exact stale chain', async () => {
    await withTree(async (tree) => {
      await prisma.agent.update({
        where: { id: tree.grandchildId },
        data: { status: 'COMPLETED' },
      });
      let attempts = 0;
      await assert.rejects(
        cleanupNonterminalDescendantWorkflows(tree.rootId, {
          terminate: async () => {
            attempts += 1;
            throw new Error('termination unavailable');
          },
        }),
        /termination unavailable/
      );
      const sealed = await prisma.agent.findUniqueOrThrow({ where: { id: tree.childId } });
      assert.strictEqual(sealed.status, 'ACTIVE');
      assert.strictEqual(sealed.staleTemporalWorkflowId, tree.childWorkflowId);
      assert.match(sealed.temporalWorkflowId ?? '', /:deployment-sealed:/);

      const executions: string[] = [];
      await cleanupNonterminalDescendantWorkflows(tree.rootId, {
        terminate: async (execution) => {
          attempts += 1;
          executions.push(`${execution.workflowId}:${execution.firstExecutionRunId}`);
        },
      });
      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(executions, [`${tree.childWorkflowId}:${tree.childId}:run`]);
      const completed = await prisma.agent.findUniqueOrThrow({ where: { id: tree.childId } });
      assert.strictEqual(completed.status, 'FAILED');
      assert.strictEqual(completed.staleTemporalWorkflowId, null);
    });
  });

  finish();
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  await prisma.$disconnect();
  process.exit(1);
});
