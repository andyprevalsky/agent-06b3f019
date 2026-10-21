import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main() {
  let rows: any[] = [];
  const broadcasts: any[] = [];
  const tx = {
    $queryRaw: async () => [],
    agent: { findUnique: async () => ({ temporalWorkflowId: 'generation' }) },
    message: {
      findMany: async () => rows,
      update: async ({ where, data }: any) =>
        Object.assign(
          rows.find((r) => r.id === where.id),
          data
        ),
      create: async ({ data }: any) => {
        const row = { ...data, id: 'new', createdAt: new Date(), filePointer: null };
        rows.push(row);
        return row;
      },
    },
  };
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: tx,
      runTransactionWithRetry: async (fn: any) => fn(tx),
    },
  });
  await mock.module('../../providers/chat/supabaseBroadcast', {
    namedExports: {
      broadcastMessageInsert: async (...args: any[]) => {
        broadcasts.push(args);
      },
    },
  });
  await mock.module('../../providers/messageGmvCapture', {
    namedExports: { scheduleMessageGmvCapture: () => {} },
  });
  const { createMessage, createWorkflowMessageGroup } = await import('../../providers/messages');
  for (const grouped of [false, true]) {
    rows = [
      {
        id: 'original',
        agentId: 'agent',
        workflowGeneration: 'generation',
        role: 'TOOL',
        timestamp: new Date('2026-01-01Z'),
        createdAt: new Date('2026-01-01Z'),
        filePointer: null,
        text: 'original error',
        metadata: {
          toolCallId: 'call',
          toolName: 'spawn_browser_agent',
          toolStatus: 'ERROR',
          workflowGeneration: 'generation',
          error: true,
        },
      },
    ];
    broadcasts.length = 0;
    const params = {
      agentId: 'agent',
      role: 'TOOL' as const,
      text: 'pause',
      enforceCurrentWorkflowGeneration: true,
      metadata: {
        workflowGeneration: 'generation',
        toolCallId: 'call',
        toolName: 'spawn_browser_agent',
        toolStatus: 'ERROR',
        userPauseRequested: true,
      },
    };
    const post = () =>
      grouped ? createWorkflowMessageGroup(params, [], 'generation') : createMessage(params);
    await post();
    await post();
    assert.equal(rows.length, 1);
    assert.equal(
      broadcasts.length,
      1,
      'in-place change broadcasts once; idempotent retry does not'
    );
    assert.equal(broadcasts[0][1].id, 'original');
    assert.ok(broadcasts[0][1].text.startsWith('original error'));
    assert.equal(broadcasts[0][1].metadata.error, true);
    assert.equal(broadcasts[0][1].metadata.userPause.reason, 'user');
  }
  console.log('browser pause delivery: PASS (both persistence entrypoints, one same-ID broadcast)');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
