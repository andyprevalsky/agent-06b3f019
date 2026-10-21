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
  process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS = '100';
  process.env.SUPABASE_BROADCAST_BATCH_SIZE = '100';

  const requestBodies: Array<{
    messages: Array<{
      topic: string;
      event: string;
      payload: { record: Record<string, unknown> };
    }>;
  }> = [];
  let fetchCalls = 0;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    requestBodies.push(
      JSON.parse(String(init?.body)) as {
        messages: Array<{
          topic: string;
          event: string;
          payload: { record: Record<string, unknown> };
        }>;
      }
    );
    return new Response('', { status: 202 });
  }) as typeof fetch;

  const broadcast = await import('../../providers/chat/supabaseBroadcast');

  try {
    await broadcast.broadcastAssistantStream(
      'immediate-agent',
      'immediate-stream',
      '',
      false,
      0,
      false,
      false,
      1_700_000_000_000
    );
    await sleep(20);
    assert.strictEqual(fetchCalls, 0, 'empty stream starts should retain the batch delay');

    await broadcast.broadcastAssistantStream(
      'immediate-agent',
      'immediate-stream',
      'first token',
      false,
      1,
      false,
      false,
      1_700_000_000_000
    );
    await sleep(20);
    assert.strictEqual(fetchCalls, 1, 'the first nonempty delta should drain immediately');
    assert.deepStrictEqual(
      requestBodies[0].messages.map((message) => message.payload.record.sequence),
      [0, 1],
      'an immediate drain must preserve FIFO order with the queued stream start'
    );
    assert.strictEqual(
      Object.hasOwn(requestBodies[0].messages[1].payload.record, 'immediateDrain'),
      false,
      'the drain priority flag must remain internal and never reach Supabase'
    );

    await broadcast.__flushBroadcastQueueForTests();

    await Promise.all([
      broadcast.broadcastAssistantStream(
        'normal-agent',
        'later-stream',
        'later token',
        false,
        2,
        false,
        false,
        1_700_000_000_001
      ),
      broadcast.broadcastAssistantStream(
        'normal-agent',
        'terminal-stream',
        '',
        true,
        3,
        false,
        false,
        1_700_000_000_002
      ),
      broadcast.broadcastAssistantStream(
        'normal-agent',
        'empty-start-stream',
        '',
        false,
        0,
        false,
        false,
        1_700_000_000_003
      ),
    ]);
    await sleep(20);
    assert.strictEqual(
      fetchCalls,
      1,
      'later deltas, terminal events, and empty starts should retain the batch delay'
    );
    await sleep(100);
    assert.strictEqual(fetchCalls, 2, 'ordinary stream events should drain after the batch delay');

    await broadcast.__flushBroadcastQueueForTests();

    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) =>
        broadcast.broadcastMessageInsert(`agent-${i}`, {
          id: `message-${i}`,
          timestamp: new Date('2026-07-08T00:00:00.000Z'),
          text: `message ${i}`,
          role: 'TOOL',
        })
      ),
      broadcast.broadcastAssistantStream(
        'router-agent',
        'router-stream',
        '',
        true,
        2,
        false,
        false,
        1_700_000_000_000,
        { clearOnDone: true }
      ),
      broadcast.broadcastAssistantStream(
        'generator-agent',
        'generator-stream',
        '',
        true,
        3,
        false,
        false,
        1_700_000_000_001
      ),
      broadcast.broadcastAssistantStream(
        'active-agent',
        'active-stream',
        'still streaming',
        false,
        4,
        false,
        false,
        1_700_000_000_002,
        { clearOnDone: true }
      ),
    ]);

    assert.strictEqual(fetchCalls, 2, 'broadcast calls should resolve after enqueue, not network');
    await sleep(120);
    assert.strictEqual(fetchCalls, 3, 'queued broadcasts should share one Supabase request');
    assert.strictEqual(requestBodies[2].messages.length, 28);

    const routerTerminal = requestBodies[2].messages.find(
      (message) => message.payload.record.stream_id === 'router-stream'
    );
    const generatorTerminal = requestBodies[2].messages.find(
      (message) => message.payload.record.stream_id === 'generator-stream'
    );
    const activeStream = requestBodies[2].messages.find(
      (message) => message.payload.record.stream_id === 'active-stream'
    );
    assert.strictEqual(routerTerminal?.event, 'ASSISTANT_STREAM');
    assert.strictEqual(routerTerminal?.payload.record.clear_on_done, true);
    assert.strictEqual(generatorTerminal?.event, 'ASSISTANT_STREAM');
    assert.strictEqual(
      Object.hasOwn(generatorTerminal?.payload.record ?? {}, 'clear_on_done'),
      false,
      'ordinary assistant streams must preserve the existing payload shape'
    );
    assert.strictEqual(
      Object.hasOwn(activeStream?.payload.record ?? {}, 'clear_on_done'),
      false,
      'clear_on_done must never be emitted before a terminal event'
    );

    await broadcast.__flushBroadcastQueueForTests();

    const attentionFetchBaseline = fetchCalls;
    await broadcast.broadcastAttentionStream('attention-agent', {
      streamId: 'answer-stream',
      toolCallId: 'answer-tool',
      message: '',
      done: false,
      sequence: 0,
    });
    await sleep(20);
    assert.strictEqual(
      fetchCalls,
      attentionFetchBaseline,
      'empty attention starts should retain the batch delay'
    );
    await broadcast.broadcastAttentionStream('attention-agent', {
      streamId: 'answer-stream',
      toolCallId: 'answer-tool',
      message: 'Hello',
      done: false,
      sequence: 1,
    });
    await sleep(20);
    assert.strictEqual(
      fetchCalls,
      attentionFetchBaseline + 1,
      'the first visible answer should drain immediately'
    );
    const attentionMessages = requestBodies.at(-1)?.messages ?? [];
    assert.deepStrictEqual(
      attentionMessages.map((message) => ({
        event: message.event,
        toolCallId: message.payload.record.tool_call_id,
        sequence: message.payload.record.sequence,
      })),
      [
        { event: 'ATTENTION_STREAM', toolCallId: 'answer-tool', sequence: 0 },
        { event: 'ATTENTION_STREAM', toolCallId: 'answer-tool', sequence: 1 },
      ],
      'attention immediate drain must preserve keyed FIFO ordering'
    );
    await broadcast.__flushBroadcastQueueForTests();
    const before = requestBodies.length;
    await broadcast.broadcastAgentUpdate(
      'jev-child',
      {
        temporalWorkflowId: 'wf',
        progressEstimate: {
          progress: 0.5,
          etaSeconds: 60,
          observedAt: '2026-10-21T01:00:00Z',
          sequence: 1,
          model: 'jev-1.13.0',
          promptVersion: 'test',
        },
      },
      'jev-root'
    );
    await broadcast.__flushBroadcastQueueForTests();
    const updates = requestBodies.slice(before).flatMap((body) => body.messages);
    assert.deepStrictEqual(updates.map((message) => message.topic).sort(), [
      'agent:jev-child',
      'bus:jev-root',
    ]);
    assert.ok(updates.every((message) => message.event === 'UPDATE'));
    assert.deepStrictEqual(updates[0].payload.record, updates[1].payload.record);
  } finally {
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
