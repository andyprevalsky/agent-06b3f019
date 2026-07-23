#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createMessage, createWorkflowMessageGroup } from '../../providers/messages';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow message generation fence unit tests');

async function createAgent(): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `workflow-message-generation-${id}`,
      goal: 'test message generation fencing',
      temporalWorkflowId: id,
      status: 'ACTIVE',
    },
  });
  return id;
}

async function main(): Promise<void> {
  await test('current workflow commits its message and attachments as one generation', async () => {
    const agentId = await createAgent();
    try {
      const result = await createWorkflowMessageGroup(
        {
          agentId,
          text: 'current assistant response',
          role: 'ASSISTANT',
          metadata: { source: 'workflow' },
          skipBroadcast: true,
        },
        [{ id: 'attachment-1' }, { id: 'attachment-2' }],
        agentId
      );

      assert.strictEqual(result.accepted, true);
      const rows = await prisma.message.findMany({
        where: { agentId },
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      });
      assert.strictEqual(rows.length, 3);
      assert(rows.every((row) => row.workflowGeneration === agentId));
      assert.strictEqual(rows.filter((row) => row.filePointer !== null).length, 2);
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('cutover atomically rejects a late message and every attachment', async () => {
    const agentId = await createAgent();
    const replacement = `${agentId}:replacement:${randomUUID()}`;
    let releaseCutover = () => {};
    let announceCutover = () => {};
    const acquired = new Promise<void>((resolve) => {
      announceCutover = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCutover = resolve;
    });
    try {
      const cutover = runTransactionWithRetry(async (tx) => {
        await lockAgentWorkflowGeneration(tx, agentId);
        announceCutover();
        await release;
        await tx.agent.update({
          where: { id: agentId },
          data: { temporalWorkflowId: replacement },
        });
      });
      await acquired;

      let settled = false;
      const staleWrite = createWorkflowMessageGroup(
        {
          agentId,
          text: 'late stale response',
          role: 'ASSISTANT',
          skipBroadcast: true,
        },
        [{ id: 'must-not-commit' }],
        agentId
      ).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(settled, false, 'message write must wait behind the cutover lock');

      releaseCutover();
      const [, result] = await Promise.all([cutover, staleWrite]);
      assert.strictEqual(result.accepted, false);
      assert.strictEqual(await prisma.message.count({ where: { agentId } }), 0);
    } finally {
      releaseCutover();
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('external user writes remain valid after a workflow generation changes', async () => {
    const agentId = await createAgent();
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: `${agentId}:replacement:${randomUUID()}` },
      });
      const message = await createMessage({
        agentId,
        text: 'legitimate user follow-up',
        role: 'USER',
        skipBroadcast: true,
      });
      assert.strictEqual(message.workflowGeneration, null);
      assert.strictEqual(message.text, 'legitimate user follow-up');
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  await test('an idempotent internal retry cannot duplicate attachment rows', async () => {
    const agentId = await createAgent();
    const params = {
      agentId,
      text: '',
      role: 'USER' as const,
      metadata: {
        isResponseSchemaUpdate: true,
        idempotencyKey: `schema-${randomUUID()}`,
      },
      skipBroadcast: true,
    };
    try {
      const first = await createWorkflowMessageGroup(params, [{ id: 'schema-file' }], agentId);
      const retry = await createWorkflowMessageGroup(params, [{ id: 'schema-file' }], agentId);
      assert.strictEqual(first.accepted, true);
      assert.strictEqual(retry.accepted, true);
      assert.strictEqual(first.message?.id, retry.message?.id);
      assert.strictEqual(await prisma.message.count({ where: { agentId } }), 2);
    } finally {
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
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
