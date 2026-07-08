#!/usr/bin/env tsx

import assert from 'node:assert';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const oldDelay = process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS;
  const oldBatchSize = process.env.SUPABASE_BROADCAST_BATCH_SIZE;

  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS = '25';
  process.env.SUPABASE_BROADCAST_BATCH_SIZE = '100';

  const fetchResolvers: Array<() => void> = [];
  const requestBodies: Array<{ messages: unknown[] }> = [];
  let fetchCalls = 0;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    requestBodies.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
    await new Promise<void>((resolve) => fetchResolvers.push(resolve));
    return new Response('', { status: 202 });
  }) as typeof fetch;

  const broadcast = await import('../../providers/chat/supabaseBroadcast');

  try {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        broadcast.broadcastMessageInsert(`agent-${i}`, {
          id: `message-${i}`,
          timestamp: new Date('2026-07-08T00:00:00.000Z'),
          text: `message ${i}`,
          role: 'TOOL',
        })
      )
    );

    assert.strictEqual(fetchCalls, 0, 'broadcast calls should resolve after enqueue, not network');
    await sleep(50);
    assert.strictEqual(fetchCalls, 1, 'queued broadcasts should share one Supabase request');
    assert.strictEqual(requestBodies[0].messages.length, 25);

    fetchResolvers.forEach((resolve) => resolve());
    await broadcast.__flushBroadcastQueueForTests();
  } finally {
    fetchResolvers.forEach((resolve) => resolve());
    await broadcast.__flushBroadcastQueueForTests();
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
    if (oldDelay === undefined) delete process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS;
    else process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS = oldDelay;
    if (oldBatchSize === undefined) delete process.env.SUPABASE_BROADCAST_BATCH_SIZE;
    else process.env.SUPABASE_BROADCAST_BATCH_SIZE = oldBatchSize;
  }

  process.stdout.write('supabase broadcast batching test passed\n');
}

run().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.stderr.write('\n');
  process.exit(1);
});
