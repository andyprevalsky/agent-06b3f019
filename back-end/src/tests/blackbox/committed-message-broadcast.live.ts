/**
 * Live mode of committed-message-broadcast.blackbox.ts, run with
 * COMMITTED_BROADCAST_LIVE=1. Sends the recorded WAF-blocked record through the
 * real publisher to the Supabase project in back-end/.env, observes it with a
 * real subscriber, and prints the wire statuses and received frames.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { blockedRecord, decodeEncoded } from './committed-message-broadcast.fixtures';

/** Real publisher + real Supabase project + real subscriber; prints the proof. */
export async function liveMain() {
  const publisher = await import('../../providers/chat/supabaseBroadcast');
  const { createClient } = await import('@supabase/supabase-js');
  const realFetch = globalThis.fetch;
  const wire: Array<{ event: string; status: number | string }> = [];
  globalThis.fetch = (async (url, init) => {
    const events = (
      JSON.parse(String(init?.body)) as { messages: Array<{ event: string }> }
    ).messages.map((row) => row.event);
    try {
      const response = await realFetch(url, init);
      for (const event of events) wire.push({ event, status: response.status });
      return response;
    } catch (error) {
      for (const event of events) wire.push({ event, status: 'error' });
      throw error;
    }
  }) as typeof fetch;
  const agentId = `q4-live-${randomUUID()}`;
  const received: Array<{ event: string; record: Record<string, unknown> }> = [];
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const channel = client.channel(`agent:${agentId}`);
  let frameArrived!: () => void;
  const firstFrame = new Promise<void>((resolve) => {
    frameArrived = resolve;
  });
  channel.on('broadcast', { event: '*' }, (message) => {
    const payload = message.payload as { record: Record<string, unknown> };
    received.push({ event: message.event, record: payload.record });
    frameArrived();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe timed out')), 15_000);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  try {
    // Same shape and size as the refused 158,184-char row.
    const record = blockedRecord(`live-${randomUUID()}`, 158_184);
    await publisher.broadcastMessageInsert(agentId, record);
    await publisher.__flushBroadcastQueueForTests();
    await Promise.race([firstFrame, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    process.stdout.write(`LIVE wire: ${JSON.stringify(wire)}\n`);
    process.stdout.write(
      `LIVE subscriber: ${JSON.stringify(received.map((row) => ({ event: row.event, id: row.record.id })))}\n`
    );
    assert.deepEqual(wire[0], { event: 'INSERT', status: 403 }, 'the plain frame is refused');
    assert.deepEqual(
      wire[1],
      { event: 'INSERT_ENCODED', status: 202 },
      'the forced frame is accepted'
    );
    assert.equal(wire.length, 2, 'no placeholder is needed once the forced frame is accepted');
    const forced = received.find((row) => row.event === 'INSERT_ENCODED');
    assert(forced, 'a real subscriber receives the forced frame');
    const decoded = decodeEncoded(forced.record);
    assert.equal(decoded.text, record.text, 'the subscriber decodes the full original text');
    assert.deepEqual(decoded.metadata, record.metadata);
    process.stdout.write(
      'LIVE RESULTS: plain 403 refused; forced INSERT_ENCODED delivered intact\n'
    );
  } finally {
    globalThis.fetch = realFetch;
    await client.removeChannel(channel);
  }
}
