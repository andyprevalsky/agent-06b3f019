#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { resolveAndSignal } from '../../providers/gateResolution';
import {
  acceptChatWorkflowExecution,
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  lockAgentWorkflowGeneration,
  lockAgentWorkflowGenerationShared,
} from '../../providers/workflowGeneration';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow generation lock unit tests');

async function withAgent(fn: (agentId: string) => Promise<void>): Promise<void> {
  const agentId = randomUUID();
  await prisma.agent.create({
    data: {
      id: agentId,
      userId: `workflow-generation-lock-${agentId}`,
      goal: 'test workflow generation lock ordering',
      status: 'ACTIVE',
      busId: agentId,
    },
  });
  try {
    await fn(agentId);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
}

async function main(): Promise<void> {
  await test('shared locks overlap while an exclusive cutover waits for every reader', async () => {
    await withAgent(async (agentId) => {
      let releaseFirst = () => {};
      let releaseSecond = () => {};
      let announceFirst = () => {};
      let announceSecond = () => {};
      const firstAcquired = new Promise<void>((resolve) => {
        announceFirst = resolve;
      });
      const secondAcquired = new Promise<void>((resolve) => {
        announceSecond = resolve;
      });
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const holdSecond = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const transactions: Promise<unknown>[] = [];

      try {
        const first = prisma.$transaction(async (tx) => {
          await lockAgentWorkflowGenerationShared(tx, agentId);
          announceFirst();
          await holdFirst;
        });
        transactions.push(first);
        await firstAcquired;

        const second = prisma.$transaction(async (tx) => {
          await lockAgentWorkflowGenerationShared(tx, agentId);
          announceSecond();
          await holdSecond;
        });
        transactions.push(second);
        await secondAcquired;

        let exclusiveSettled = false;
        const exclusive = prisma
          .$transaction((tx) => lockAgentWorkflowGeneration(tx, agentId))
          .finally(() => {
            exclusiveSettled = true;
          });
        transactions.push(exclusive);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(exclusiveSettled, false, 'cutover must wait behind shared writers');

        releaseFirst();
        await first;
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(
          exclusiveSettled,
          false,
          'every shared writer must release before cutover'
        );

        releaseSecond();
        await Promise.all([second, exclusive]);
        assert.strictEqual(exclusiveSettled, true);
      } finally {
        releaseFirst();
        releaseSecond();
        await Promise.allSettled(transactions);
      }
    });
  });

  await test('a delayed chat escalation cannot overwrite a deployment cutover', async () => {
    await withAgent(async (agentId) => {
      const replacement = `${agentId}:replacement:${randomUUID()}`;
      let announceCutover = () => {};
      let releaseCutover = () => {};
      const cutoverLocked = new Promise<void>((resolve) => {
        announceCutover = resolve;
      });
      const cutoverMayContinue = new Promise<void>((resolve) => {
        releaseCutover = resolve;
      });
      const transactions: Promise<unknown>[] = [];

      try {
        const cutover = runTransactionWithRetry(async (tx) => {
          await lockAgentWorkflowGeneration(tx, agentId);
          announceCutover();
          await cutoverMayContinue;
          await tx.agent.update({
            where: { id: agentId },
            data: { temporalWorkflowId: replacement },
          });
        });
        transactions.push(cutover);
        await cutoverLocked;

        let chatCommitSettled = false;
        const chatCommit = acceptChatWorkflowExecution(agentId, {
          workflowId: agentId,
          firstExecutionRunId: `run-${randomUUID()}`,
        }).finally(() => {
          chatCommitSettled = true;
        });
        transactions.push(chatCommit);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(
          chatCommitSettled,
          false,
          'chat workflow ownership must wait behind the cutover lock'
        );

        releaseCutover();
        const [, accepted] = await Promise.all([cutover, chatCommit]);
        assert.strictEqual(accepted, false);
        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.strictEqual(stored.temporalWorkflowId, replacement);
        assert.strictEqual(stored.temporalFirstExecutionRunId, null);
      } finally {
        releaseCutover();
        await Promise.allSettled(transactions);
      }
    });
  });

  await test('approval resolution follows deployment cleanup lock order', async () => {
    await withAgent(async (agentId) => {
      const requestId = randomUUID();
      await prisma.agentAttentionRequest.create({
        data: {
          id: requestId,
          userId: `workflow-generation-lock-${agentId}`,
          agentId,
          workflowId: agentId,
          question: 'Approve while deployment cleanup starts?',
        },
      });

      let announceCleanupLock = () => {};
      let releaseCleanup = () => {};
      const cleanupLocked = new Promise<void>((resolve) => {
        announceCleanupLock = resolve;
      });
      const cleanupMayContinue = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const transactions: Promise<unknown>[] = [];

      try {
        const cleanup = prisma.$transaction(async (tx) => {
          await lockAgentWorkflowGeneration(tx, agentId);
          announceCleanupLock();
          await cleanupMayContinue;
          await tx.agentAttentionRequest.updateMany({
            where: { id: requestId, userResponse: null },
            data: { userResponse: DEPLOY_INTERRUPTED_TOOL_MESSAGE },
          });
        });
        transactions.push(cleanup);
        await cleanupLocked;

        const resolution = resolveAndSignal(
          { id: requestId, agentId, workflowId: agentId, metadata: null },
          'approved during cleanup'
        );
        transactions.push(resolution);
        // The inverse order deadlocks when cleanup proceeds to the request row.
        await new Promise((resolve) => setTimeout(resolve, 100));
        releaseCleanup();

        const [, result] = await Promise.all([cleanup, resolution]);
        assert.deepStrictEqual(result, { resolved: false });
        const request = await prisma.agentAttentionRequest.findUniqueOrThrow({
          where: { id: requestId },
        });
        assert.strictEqual(request.userResponse, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
      } finally {
        releaseCleanup();
        await Promise.allSettled(transactions);
      }
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
