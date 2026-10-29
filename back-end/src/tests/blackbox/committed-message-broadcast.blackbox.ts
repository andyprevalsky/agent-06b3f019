#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockedRecord, decodeEncoded, message } from './committed-message-broadcast.fixtures';

import { config as loadEnv } from 'dotenv';

// COMMITTED_BROADCAST_LIVE=1 sends a known WAF-blocked record through the real
// publisher to the configured Supabase project and observes it with a real
// subscriber. The default offline mode replays recorded broker responses.
const LIVE = process.env.COMMITTED_BROADCAST_LIVE === '1';
if (LIVE) {
  loadEnv({ path: join(__dirname, '../../../.env') });
} else {
  // Exercise the public publisher against an ambiguous broker result, rather
  // than importing a retry helper or modifying the production request deadline.
  process.env.SUPABASE_URL = 'https://broadcast.blackbox.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'blackbox-service-key';
}
// Lane/shard byte capacity is independent of the 8 KB live INSERT cap (covered by
// realtime-payload-cap); lift it so large rows still reach those budgets
// (LIVE mode: the 158 KB WAF row still exercises the encoded transport).
process.env.SUPABASE_BROADCAST_LIVE_INSERT_MAX_BYTES = String(1024 * 1024);
process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS = '0';
process.env.SUPABASE_BROADCAST_TIMEOUT_MS = '2000';
process.env.SUPABASE_BROADCAST_BATCH_SIZE = '1';
async function main() {
  if (LIVE) return (await import('./committed-message-broadcast.live')).liveMain();
  const publisher = await import('../../providers/chat/supabaseBroadcast');
  const originalFetch = globalThis.fetch;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  type WireMessage = {
    topic: string;
    event: string;
    payload: { record: Record<string, unknown> & { id?: string } };
  };
  const bodyMessages = (init?: RequestInit): WireMessage[] =>
    (JSON.parse(String(init?.body)) as { messages: WireMessage[] }).messages;

  let failed = 0;
  let total = 0;
  async function test(name: string, run: () => Promise<void>) {
    total += 1;
    try {
      await run();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`FAIL ${name}: ${String(error)}\n`);
    } finally {
      await publisher.__flushBroadcastQueueForTests();
    }
  }

  try {
    await test('committed INSERT retries an accepted but unacknowledged send with identical body', async () => {
      const bodies: string[] = [];
      globalThis.fetch = (async (_url, init) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) throw new DOMException('Acknowledgement lost', 'AbortError');
        return new Response('', { status: 202 });
      }) as typeof fetch;
      await publisher.broadcastMessageInsert('ambiguous-agent', message('committed-a'));
      await publisher.__flushBroadcastQueueForTests();
      assert.equal(bodies.length, 2, 'a committed INSERT must survive one ambiguous send failure');
      assert.equal(
        bodies[1],
        bodies[0],
        'the retry must preserve the original message ID and body'
      );
    });

    await test('a stalled agent preserves INSERT order without blocking another agent', async () => {
      const delivered: string[] = [];
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      let firstAttempt = true;
      let firstAborted = false;
      globalThis.fetch = (async (_url, init) => {
        const rows = bodyMessages(init);
        if (rows.some((row) => row.payload.record.id === 'ordered-a') && firstAttempt) {
          firstAttempt = false;
          firstStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                firstAborted = true;
                reject(new DOMException('Request timed out', 'AbortError'));
              },
              { once: true }
            );
          });
        }
        delivered.push(...rows.map((row) => row.payload.record.id ?? row.event));
        return new Response('', { status: 202 });
      }) as typeof fetch;
      await publisher.broadcastMessageInsert('ordered-agent', message('ordered-a'));
      await started;
      await publisher.broadcastMessageInsert('ordered-agent', message('ordered-b'));
      await publisher.broadcastMessageInsert('healthy-agent', message('healthy'));
      await sleep(150);
      assert(
        delivered.includes('healthy'),
        'another agent must deliver before the stalled attempt expires'
      );
      assert.equal(
        firstAborted,
        false,
        'isolation must not shorten the existing 2 s attempt timeout'
      );
      assert(
        !delivered.includes('ordered-b'),
        'later INSERTs must not overtake an uncertain earlier INSERT'
      );
      await publisher.__flushBroadcastQueueForTests();
      assert(delivered.indexOf('ordered-a') < delivered.indexOf('ordered-b'));
    });

    // Semantic gate 2026-10-28 (agent d631f487): a generator burst filled the
    // topic's 64-message initial queue while one request was in flight, so the
    // canonical final-answer INSERT was refused for 'capacity' and dropped.
    await test('a stream-delta burst cannot crowd out the committed final answer', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const delivered: string[] = [];
      globalThis.fetch = (async (_url, init) => {
        const rows = bodyMessages(init);
        started();
        await gate;
        delivered.push(...rows.map((row) => row.payload.record.id ?? row.event));
        return new Response('', { status: 202 });
      }) as typeof fetch;
      try {
        await publisher.broadcastAssistantStream('burst-agent', 'gen', 'first', false, 1);
        await firstStarted;
        for (let sequence = 2; sequence <= 120; sequence += 1) {
          await publisher.broadcastAssistantStream('burst-agent', 'gen', 'delta', false, sequence);
        }
        await publisher.broadcastMessageInsert('burst-agent', message('burst-final-answer'));
      } finally {
        release();
      }
      await publisher.__flushBroadcastQueueForTests();
      assert(
        delivered.includes('burst-final-answer'),
        'droppable stream deltas must never cost the committed INSERT its delivery'
      );
      assert.equal(
        delivered.at(-1),
        'burst-final-answer',
        'the committed INSERT must stay ordered after the deltas it replaces'
      );
    });

    await test('ephemeral stream failures are not retried', async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response('', { status: 503 });
      }) as typeof fetch;
      await publisher.broadcastAssistantStream('ephemeral-agent', 'stream', 'delta', false, 1);
      await publisher.__flushBroadcastQueueForTests();
      assert.equal(calls, 1);
    });

    await test('retryable failures exhaust three sends with an attributed receipt; 403 is not retried', async () => {
      const write = process.stderr.write;
      const receipts: string[] = [];
      process.stderr.write = ((chunk) => {
        receipts.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        let calls = 0;
        globalThis.fetch = (async () => {
          calls += 1;
          return new Response('', { status: 503 });
        }) as typeof fetch;
        await publisher.broadcastMessageInsert('exhaustion-agent', message('exhausted-id'));
        await publisher.__flushBroadcastQueueForTests();
        assert.equal(calls, 3, 'retryable failure must have a finite send budget');
        assert(
          receipts.some(
            (line) => line.includes('delivery exhausted') && line.includes('exhausted-id')
          )
        );
        const events: string[] = [];
        globalThis.fetch = (async (_url, init) => {
          events.push(...bodyMessages(init).map((row) => row.event));
          return new Response('', { status: 403 });
        }) as typeof fetch;
        await publisher.broadcastMessageInsert('exhaustion-agent', message('denied-id'));
        await publisher.__flushBroadcastQueueForTests();
        assert.deepEqual(
          events,
          ['INSERT', 'INSERT_ENCODED', 'INSERT_DEFERRED'],
          'permission failures never resend the plain record; each substitute is sent once'
        );
        assert(
          receipts.some(
            (line) => line.includes('delivery exhausted') && line.includes('denied-id')
          ),
          'a refused notice still leaves an attributed exhaustion receipt'
        );
      } finally {
        process.stderr.write = write;
      }
    });

    await test('a content-rejected committed INSERT is forced through once in base64', async () => {
      // Replays descend-full69 r004-j0049: Supabase's edge WAF returned this
      // 403 page for every INSERT whose record carried the codex shell command.
      const wafPage = readFileSync(
        join(__dirname, '../fixtures/supabase-broadcast-waf-403-a4f47669fe39d6d3.html'),
        'utf8'
      );
      const sent: WireMessage[] = [];
      const delivered: WireMessage[] = [];
      globalThis.fetch = (async (_url, init) => {
        const rows = bodyMessages(init);
        sent.push(...rows);
        if (String(init?.body).includes('curl -L --fail --silent')) {
          return new Response(wafPage, { status: 403, headers: { 'content-type': 'text/html' } });
        }
        delivered.push(...rows);
        return new Response('', { status: 202 });
      }) as typeof fetch;
      const record = blockedRecord('waf-blocked');
      await publisher.broadcastMessageInsert('waf-agent', record);
      await publisher.__flushBroadcastQueueForTests();
      assert.deepEqual(
        sent.map((row) => row.event),
        ['INSERT', 'INSERT_ENCODED'],
        'one plain send, then exactly one forced send of the same record'
      );
      const forced = delivered.find((row) => row.payload.record.id === 'waf-blocked');
      assert(forced, 'the subscribed client must receive committed row waf-blocked');
      assert.equal(forced.topic, 'agent:waf-agent');
      assert.equal(forced.event, 'INSERT_ENCODED');
      const decoded = decodeEncoded(forced.payload.record);
      assert.equal(decoded.text, record.text, 'the forced frame carries the full text');
      assert.deepEqual(decoded.metadata, record.metadata);
    });

    await test('when the forced frame is also refused the client gets a visible reason and the id', async () => {
      const sent: WireMessage[] = [];
      const delivered: WireMessage[] = [];
      globalThis.fetch = (async (_url, init) => {
        const rows = bodyMessages(init);
        sent.push(...rows);
        if (rows.some((row) => row.event !== 'INSERT_DEFERRED')) {
          return new Response('blocked', { status: 403 });
        }
        delivered.push(...rows);
        return new Response('', { status: 202 });
      }) as typeof fetch;
      await publisher.broadcastMessageInsert('waf-agent', blockedRecord('waf-both-blocked'));
      await publisher.__flushBroadcastQueueForTests();
      assert.deepEqual(
        sent.map((row) => row.event),
        ['INSERT', 'INSERT_ENCODED', 'INSERT_DEFERRED']
      );
      const notice = delivered[0]?.payload.record as Record<string, unknown> | undefined;
      assert(notice, 'the subscribed client must learn that committed row waf-both-blocked exists');
      assert.equal(notice.id, 'waf-both-blocked');
      assert.equal(notice.reason, publisher.BLOCKED_STREAM_REASON);
      assert.deepEqual(notice.metadata, {
        toolName: 'spawn_claude_code_agent',
        toolStatus: 'FINISHED',
        toolCallId: 'call_530ea3ca9bf640358d491ade206558b2',
        success: true,
      });
      assert.deepEqual(
        Object.keys(notice).sort(),
        ['agentId', 'id', 'metadata', 'reason', 'role', 'timestamp'],
        'the placeholder never carries the refused content'
      );
    });

    await test('pending message and byte caps reject visibly and release capacity after completion', async () => {
      const write = process.stderr.write;
      const receipts: string[] = [];
      process.stderr.write = ((chunk) => {
        receipts.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sent: string[] = [];
      const frames: WireMessage[] = [];
      globalThis.fetch = (async (_url, init) => {
        frames.push(...bodyMessages(init));
        sent.push(...bodyMessages(init).map((row) => row.payload.record.id!));
        await gate;
        return new Response('', { status: 202 });
      }) as typeof fetch;
      try {
        for (let index = 0; index < 40; index += 1) {
          await publisher.broadcastMessageInsert('capacity-agent', message(`capped-${index}`));
        }
        await sleep(30);
        release();
        await publisher.__flushBroadcastQueueForTests();
        assert.equal(sent.length, 32, 'one agent may retain only 32 pending committed INSERTs');
        assert.equal(receipts.filter((line) => line.includes('delivery rejected')).length, 8);
        const before = sent.length;
        await publisher.broadcastMessageInsert('capacity-agent', {
          ...message('oversized'),
          text: 'x'.repeat(256 * 1024),
        });
        await publisher.__flushBroadcastQueueForTests();
        assert.deepEqual(
          sent.slice(before),
          ['oversized'],
          'an oversized row must still be announced to the client'
        );
        const substitute = frames.at(-1)!;
        assert.equal(
          substitute.event,
          'INSERT_DEFERRED',
          'its content must not bypass byte admission'
        );
        assert.equal(substitute.payload.record.reason, publisher.OVERSIZE_STREAM_REASON);
        assert.equal(substitute.payload.record.text, undefined);
        assert(
          receipts.some((line) => line.includes('delivery rejected') && line.includes('oversized'))
        );
        await publisher.broadcastMessageInsert('capacity-agent', message('after-capacity-release'));
        await publisher.__flushBroadcastQueueForTests();
        assert.equal(sent.at(-1), 'after-capacity-release');
      } finally {
        release();
        process.stderr.write = write;
      }
    });

    await test('initial batch concurrency is bounded and resumes after occupied slots settle', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        await gate;
        return new Response('', { status: 202 });
      }) as typeof fetch;
      try {
        for (let index = 0; index < 65; index += 1) {
          await publisher.broadcastMessageInsert(
            `window-agent-${index}`,
            message(`window-${index}`)
          );
        }
        await sleep(50);
        assert.equal(
          calls,
          64,
          'the initial dispatcher must have a finite parallel request window'
        );
      } finally {
        release();
      }
      await publisher.__flushBroadcastQueueForTests();
      assert.equal(calls, 65, 'admitted work must resume once a slot is released');
    });

    await test('same-topic ephemeral requests preserve order while another topic progresses', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const delivered: string[] = [];
      globalThis.fetch = (async (_url, init) => {
        const rows = bodyMessages(init);
        if (
          rows.some(
            (row) =>
              row.topic === 'agent:ephemeral-ordered' &&
              (row.payload.record as Record<string, unknown>).status === 'IN_PROGRESS'
          )
        ) {
          started();
          await gate;
        }
        delivered.push(
          ...rows.map(
            (row) =>
              `${row.topic}:${String((row.payload.record as Record<string, unknown>).status ?? row.event)}`
          )
        );
        return new Response('', { status: 202 });
      }) as typeof fetch;
      try {
        await publisher.broadcastToolEvent(
          'ephemeral-ordered',
          'tool-stream',
          'call',
          'browser',
          'IN_PROGRESS',
          'Opening'
        );
        await firstStarted;
        await publisher.broadcastToolEvent(
          'ephemeral-ordered',
          'tool-stream',
          'call',
          'browser',
          'FINISHED',
          'Done'
        );
        await publisher.broadcastMessageInsert('ephemeral-healthy', message('ephemeral-healthy'));
        await sleep(50);
        assert(
          delivered.includes('agent:ephemeral-healthy:INSERT'),
          'an independent topic must progress'
        );
        assert(
          !delivered.includes('agent:ephemeral-ordered:FINISHED'),
          'a terminal event must not overtake its initial event'
        );
      } finally {
        release();
      }
      await publisher.__flushBroadcastQueueForTests();
      assert(
        delivered.indexOf('agent:ephemeral-ordered:IN_PROGRESS') <
          delivered.indexOf('agent:ephemeral-ordered:FINISHED')
      );
    });

    await test('retry settlement does not retain initial HTTP request slots', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attempted = new Set<string>();
      let healthy = false;
      let retries = 0;
      let retryStarted!: () => void;
      let rejectMissingRetry!: () => void;
      const firstRetryStarted = new Promise<void>((resolve, reject) => {
        retryStarted = resolve;
        rejectMissingRetry = () => reject(new Error('fixture ended before any retry started'));
      });
      process.once('beforeExit', rejectMissingRetry);
      globalThis.fetch = (async (_url, init) => {
        const topic = bodyMessages(init)[0].topic;
        if (topic === 'agent:healthy-after-failures') {
          healthy = true;
          return new Response('', { status: 202 });
        }
        if (!attempted.has(topic)) {
          attempted.add(topic);
          // Initial HTTP work and retry backoff are separate phases. The
          // readiness assertion must observe a retry, not assume both fit 150 ms.
          await sleep(80);
          return new Response('', { status: 503 });
        }
        retries += 1;
        retryStarted();
        await gate;
        return new Response('', { status: 202 });
      }) as typeof fetch;
      try {
        for (let index = 0; index < 64; index += 1) {
          await publisher.broadcastMessageInsert(
            `settlement-${index}`,
            message(`settlement-${index}`)
          );
        }
        await firstRetryStarted;
        assert(retries > 0, 'the fixture must have retry settlements in flight');
        await publisher.broadcastMessageInsert(
          'healthy-after-failures',
          message('healthy-after-failures')
        );
        await sleep(50);
        assert(healthy, 'retry settlements must not occupy the initial request window');
      } finally {
        process.removeListener('beforeExit', rejectMissingRetry);
        release();
      }
      await publisher.__flushBroadcastQueueForTests();
    });

    const shardPeers = [
      'shard-peer-26',
      'shard-peer-167',
      'shard-peer-200',
      'shard-peer-288',
      'shard-peer-321',
    ];
    await test('accounting shard byte admission is bounded across distinct agents', async () => {
      const write = process.stderr.write;
      const receipts: string[] = [];
      process.stderr.write = ((chunk) => {
        receipts.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        await gate;
        return new Response('', { status: 202 });
      }) as typeof fetch;
      try {
        for (const peer of shardPeers) {
          await publisher.broadcastMessageInsert(peer, {
            ...message(peer),
            text: 'x'.repeat(240 * 1024),
          });
        }
        await sleep(30);
        assert.equal(calls, 4, 'one accounting shard must not retain more than 1 MiB');
        assert(
          receipts.some(
            (line) => line.includes('delivery rejected') && line.includes(shardPeers[4])
          )
        );
      } finally {
        release();
        process.stderr.write = write;
      }
      await publisher.__flushBroadcastQueueForTests();
    });

    await test('retry concurrency is bounded within a shard', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attempts = new Map<string, number>();
      let active = 0;
      let peak = 0;
      globalThis.fetch = (async (_url, init) => {
        const topic = bodyMessages(init)[0].topic;
        const attempt = (attempts.get(topic) ?? 0) + 1;
        attempts.set(topic, attempt);
        if (attempt === 1) return new Response('', { status: 503 });
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return new Response('', { status: 202 });
      }) as typeof fetch;
      try {
        for (const peer of shardPeers) await publisher.broadcastMessageInsert(peer, message(peer));
        // Retries are timer-driven: under a loaded coverage run they can take
        // longer than a fixed sleep to reach the cap. Wait for the cap, then
        // give a fifth request time to (wrongly) start.
        for (let waited = 0; active < 4 && waited < 3000; waited += 25) await sleep(25);
        await sleep(150);
        assert.equal(active, 4, 'one shard may issue only four retry requests concurrently');
      } finally {
        release();
      }
      await publisher.__flushBroadcastQueueForTests();
      assert.equal(peak, 4);
      assert([...attempts.values()].every((count) => count === 2));
    });
    await test('a same-tick burst of stream deltas reaches the client whole, and the turn INSERT still sends', async () => {
      // Prod 2026-10-27/28: a generator emitted ~240 ASSISTANT_STREAM deltas for one
      // agent inside one event-loop tick, before the drain timer could run. The
      // 64-message topic queue rejected the rest ("capacity"), the client's text
      // lost those chunks, and the turn's committed INSERT was refused too.
      const sent: WireMessage[] = [];
      globalThis.fetch = (async (_url, init) => {
        sent.push(...bodyMessages(init));
        return new Response('', { status: 202 });
      }) as typeof fetch;
      const agentId = 'burst-agent-0001';
      const chunks = Array.from({ length: 240 }, (_, index) => `w${index} `);
      for (const [index, chunk] of chunks.entries()) {
        await publisher.broadcastAssistantStream(agentId, 'burst-stream', chunk, false, index + 1);
      }
      await publisher.broadcastAssistantStream(
        agentId,
        'burst-stream',
        '',
        true,
        chunks.length + 1
      );
      await publisher.broadcastMessageInsert(agentId, message('burst-final'));
      await publisher.__flushBroadcastQueueForTests();

      // Apply frames exactly as realtimeHandlers.handleAssistantStream does.
      let text = '';
      let sequence = 0;
      let done = false;
      for (const frame of sent.filter((wire) => wire.event === 'ASSISTANT_STREAM')) {
        const record = frame.payload.record as { delta: string; sequence: number; done: boolean };
        if (record.sequence < sequence) continue;
        text += record.delta;
        sequence = record.sequence;
        done = record.done;
      }
      assert.equal(
        text,
        chunks.join(''),
        'every streamed character must reach the client in order'
      );
      assert.equal(done, true, 'the stream must end with its done frame');
      assert(
        sent.some((wire) => wire.event === 'INSERT' && wire.payload.record.id === 'burst-final'),
        'the committed INSERT after the burst must be sent'
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  process.stdout.write(`RESULTS: ${total - failed}/${total} passed\n`);
  process.exitCode = failed ? 1 : 0;
}
void main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
