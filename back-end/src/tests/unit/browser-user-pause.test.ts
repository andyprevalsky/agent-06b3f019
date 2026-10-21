import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { Message, Prisma } from '@prisma/client';

async function main() {
  await mock.module('../../providers/database', {
    namedExports: {
      runTransactionWithRetry: () => {
        throw new Error('unexpected database');
      },
    },
  });
  const { persistLockedToolLifecycleMessage } =
    await import('../../providers/toolLifecycleMessages');
  const identity = { toolCallId: 'call', workflowGeneration: 'generation' };
  const base = (status = 'ERROR'): Message =>
    ({
      id: 'original',
      agentId: 'agent',
      workflowGeneration: 'generation',
      role: 'TOOL',
      text: 'Partial work\nOriginal error details',
      timestamp: new Date('2026-01-01Z'),
      createdAt: new Date('2026-01-01Z'),
      filePointer: null,
      metadata: {
        toolCallId: 'call',
        toolName: 'spawn_browser_agent',
        toolStatus: status,
        error: true,
        errorCode: 'ORIGINAL',
        structured_response: { result: 'saved' },
      },
    }) as Message;
  function fixture(rows: Message[], generation = 'generation') {
    const events: string[] = [];
    const tx = {
      $queryRaw: async () => {
        events.push('lock');
        return [];
      },
      agent: { findUnique: async () => ({ temporalWorkflowId: generation }) },
      message: {
        findMany: async () => rows,
        update: async ({ where, data }: any) => {
          events.push('update');
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
        create: async ({ data }: any) => {
          events.push('create');
          const row = { ...base(), ...data, id: 'created' };
          rows.push(row);
          return row;
        },
      },
    } as unknown as Prisma.TransactionClient;
    return { rows, tx, events };
  }
  const params = {
    agentId: 'agent',
    role: 'TOOL' as const,
    text: 'User paused the browser agent',
    enforceCurrentWorkflowGeneration: true,
    metadata: {
      workflowGeneration: 'generation',
      toolCallId: 'call',
      toolName: 'spawn_browser_agent',
      toolStatus: 'ERROR',
      userPauseRequested: true,
    },
  };
  for (const status of ['ERROR', 'FINISHED', 'IN_PROGRESS']) {
    const f = fixture([base(status)]);
    const original = structuredClone(f.rows[0]);
    const result = await persistLockedToolLifecycleMessage(f.tx, params, identity);
    assert.equal(f.rows.length, 1, 'pause must annotate one owned row, not create a replacement');
    assert.equal(result.message.id, original.id);
    assert.equal(result.message.timestamp.toISOString(), original.timestamp.toISOString());
    assert.equal(result.message.createdAt.toISOString(), original.createdAt.toISOString());
    assert.ok(
      result.message.text.startsWith(original.text),
      'original content must survive byte-for-byte'
    );
    const metadata = result.message.metadata as any;
    assert.equal(metadata.errorCode, 'ORIGINAL');
    assert.equal(metadata.error, true);
    assert.deepEqual(metadata.structured_response, { result: 'saved' });
    assert.equal(metadata.userPause.reason, 'user');
    assert.equal(metadata.toolStatus, status === 'IN_PROGRESS' ? 'FINISHED' : status);
    assert.deepEqual(f.events, ['lock', 'lock', 'update']);
    const once = structuredClone(result.message);
    await persistLockedToolLifecycleMessage(f.tx, params, identity);
    assert.deepEqual(f.rows, [once], 'repeat pause is idempotent');
    // A cancelled attempt's late finalizer cannot replace the sealed result.
    await persistLockedToolLifecycleMessage(
      f.tx,
      {
        ...params,
        text: 'late overwrite',
        metadata: { ...params.metadata, userPauseRequested: undefined },
      },
      identity
    );
    assert.deepEqual(f.rows, [once], 'late completion cannot erase pause or original result');
  }
  const priorCleanup = fixture([
    {
      ...base(),
      metadata: {
        ...(base().metadata as object),
        browser_cleanup: { error: 'earlier close failed' },
      },
    },
  ]);
  await persistLockedToolLifecycleMessage(
    priorCleanup.tx,
    {
      ...params,
      metadata: {
        ...params.metadata,
        browser_cleanup: { error: 'pause close failed' },
      },
    },
    identity
  );
  const both = priorCleanup.rows[0].metadata as any;
  assert.deepEqual(both.browser_cleanup, { error: 'earlier close failed' });
  assert.deepEqual(both.userPause.browserCleanup, { error: 'pause close failed' });
  const cleanup = fixture([base()]);
  await persistLockedToolLifecycleMessage(cleanup.tx, params, identity);
  const receipt = await persistLockedToolLifecycleMessage(
    cleanup.tx,
    {
      ...params,
      text: 'recording receipt',
      metadata: {
        ...params.metadata,
        userPauseRequested: false,
        excludeFromModel: true,
        browser_cleanup: { status: 'closed' },
      },
    },
    identity
  );
  assert.equal(receipt.created, true, 'model-excluded cleanup receipts must still persist');
  assert.equal(cleanup.rows.length, 2);
  const empty = fixture([]);
  await persistLockedToolLifecycleMessage(empty.tx, params, identity);
  await persistLockedToolLifecycleMessage(empty.tx, params, identity);
  assert.equal(empty.rows.length, 1, 'no prior result still gets exactly one terminal');
  const stale = fixture([base()], 'new-generation');
  const staleResult = await persistLockedToolLifecycleMessage(stale.tx, params, identity);
  assert.equal(staleResult.accepted, false);
  assert.equal((stale.rows[0].metadata as any).userPause, undefined, 'stale pause never annotates');
  console.log(
    'browser user pause: PASS (preservation, original clocks, repeat, late write, empty, generation fence)'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
