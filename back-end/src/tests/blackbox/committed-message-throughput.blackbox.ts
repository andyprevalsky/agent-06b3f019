#!/usr/bin/env tsx

import assert from 'node:assert/strict';

// Captured load: one root persisted up to 59 messages/s while healthy sends
// generally completed in 47–133 ms. Keep production caps and deadlines.
process.env.SUPABASE_URL = 'https://broadcast.blackbox.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'blackbox-service-key';
// Lane/shard byte capacity is independent of the 8 KB live INSERT cap (covered by
// realtime-payload-cap); lift it so large rows still reach those budgets.
process.env.SUPABASE_BROADCAST_LIVE_INSERT_MAX_BYTES = String(1024 * 1024);
process.env.SUPABASE_BROADCAST_FLUSH_DELAY_MS = '10';
process.env.SUPABASE_BROADCAST_TIMEOUT_MS = '2000';
process.env.SUPABASE_BROADCAST_BATCH_SIZE = '100';

async function main() {
  const publisher = await import('../../providers/chat/supabaseBroadcast');
  const originalFetch = globalThis.fetch;
  const stderrWrite = process.stderr.write;
  const rejections: string[] = [];
  const received: string[] = [];
  const batches: number[] = [];
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  process.stderr.write = ((chunk) => {
    const line = String(chunk);
    if (line.includes('delivery rejected')) rejections.push(line);
    return stderrWrite.call(process.stderr, chunk);
  }) as typeof process.stderr.write;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ payload: { record: { id: string } } }>;
    };
    batches.push(body.messages.length);
    await sleep(100);
    received.push(...body.messages.map((row) => row.payload.record.id));
    return new Response('', { status: 202 });
  }) as typeof fetch;
  const expected = Array.from({ length: 60 }, (_, index) => `load-notification-${index}`);
  try {
    for (const id of expected) {
      await publisher.broadcastMessageInsert('captured-load-root', {
        id,
        timestamp: new Date('2026-10-13T04:36:00Z'),
        text: 'A concurrent child completed.',
        role: 'TOOL',
        metadata: { toolName: 'spawn_agent', toolStatus: 'FINISHED', toolCallId: id },
      });
      await sleep(1000 / 60);
    }
    assert.equal(
      rejections.length,
      0,
      'healthy 100 ms sends must admit the captured ~60 writes/s without notification drops'
    );
    await publisher.__flushBroadcastQueueForTests();
    assert.deepEqual(
      received,
      expected,
      'all accepted notifications must arrive once in FIFO order'
    );
    assert(
      batches.some((size) => size > 1),
      'queued committed notifications must share requests'
    );
    assert(
      batches.every((size) => size <= 100),
      'the production request cap remains 100'
    );
    process.stdout.write(
      `PASS captured 60/s notification cadence, 100 ms healthy sends (${batches.length} requests)\n`
    );
    await atomicRetry(publisher);
    await byteBoundedCohort(publisher);
    await occupiedInitialTopic(publisher, 'messages');
    await occupiedInitialTopic(publisher, 'bytes');
    await atomicAgeCutoff(publisher);
    assert.equal(rejections.length, 0, 'valid cohorts must not create capacity rejections');
  } finally {
    await publisher.__flushBroadcastQueueForTests();
    globalThis.fetch = originalFetch;
    process.stderr.write = stderrWrite;
  }
}

type Publisher = typeof import('../../providers/chat/supabaseBroadcast');
type WireMessage = { event: string; payload: { record: { id?: string; text?: string } } };
const rows = (init?: RequestInit): WireMessage[] => JSON.parse(String(init?.body)).messages;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (id: string, text = 'Opening browser') => ({
  id,
  timestamp: new Date('2026-10-13T04:36:00Z'),
  text,
  role: 'TOOL',
  metadata: { toolName: 'spawn_agent', toolStatus: 'FINISHED', toolCallId: id },
});

async function atomicRetry(publisher: Publisher): Promise<void> {
  let release!: (response: Response) => void;
  let started!: () => void;
  let cohortStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const failedCohort = new Promise<void>((resolve) => {
    cohortStarted = resolve;
  });
  const cohortBodies: string[] = [];
  const sizes: number[] = [];
  const delivered: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const batch = rows(init);
    sizes.push(batch.length);
    if (batch.some((row) => row.payload.record.id === 'cohort-prefix')) {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    if (batch.some((row) => row.payload.record.id === 'cohort-0')) {
      assert.equal(batch.length, 31, 'remaining mixed-batch budget must not split a cohort');
      cohortBodies.push(String(init?.body));
      if (cohortBodies.length === 1) {
        cohortStarted();
        throw new DOMException('Acknowledgement lost', 'AbortError');
      }
    }
    delivered.push(...batch.flatMap((row) => row.payload.record.id ?? []));
    return new Response('', { status: 202 });
  }) as typeof fetch;
  await publisher.broadcastMessageInsert('cohort-root', message('cohort-prefix'));
  await firstStarted;
  const expected = Array.from({ length: 31 }, (_, index) => `cohort-${index}`);
  const mutable = message('cohort-0');
  await Promise.all(
    expected.map((id, index) =>
      publisher.broadcastMessageInsert('cohort-root', index === 0 ? mutable : message(id))
    )
  );
  mutable.text = 'mutated after enqueue';
  await Promise.all(
    Array.from({ length: 70 }, (_, index) =>
      publisher.broadcastAgentUpdate(`mixed-${index}`, { progress: index })
    )
  );
  release(new Response('', { status: 202 }));
  await failedCohort;
  await publisher.broadcastMessageInsert('cohort-root', message('cohort-tail'));
  await publisher.broadcastMessageInsert('cohort-healthy', message('cohort-healthy'));
  await sleep(50);
  assert(
    delivered.includes('cohort-healthy'),
    'a different topic must progress during cohort backoff'
  );
  assert(
    !delivered.includes('cohort-tail'),
    'later committed inserts must wait for failed cohort recovery'
  );
  await publisher.__flushBroadcastQueueForTests();
  assert.equal(cohortBodies.length, 2);
  assert.equal(
    cohortBodies[0],
    cohortBodies[1],
    'cohort retry must preserve every frozen ID and payload'
  );
  assert(!cohortBodies[0].includes('mutated after enqueue'));
  assert(
    sizes.includes(70),
    'the mixed ephemeral request must leave too little room for the atomic cohort'
  );
  assert.deepEqual(
    delivered.filter((id) => id !== 'cohort-healthy'),
    [...expected, 'cohort-tail']
  );
  process.stdout.write(
    'PASS atomic mixed-batch cohort, frozen retry, and independent-topic progress\n'
  );
}

async function byteBoundedCohort(publisher: Publisher): Promise<void> {
  let release!: (response: Response) => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delivered: string[] = [];
  const sizes: number[] = [];
  globalThis.fetch = (async (_url, init) => {
    const batch = rows(init);
    if (batch[0].payload.record.id === 'byte-prefix') {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    sizes.push(batch.length);
    delivered.push(...batch.flatMap((row) => row.payload.record.id ?? []));
    return new Response('', { status: 202 });
  }) as typeof fetch;
  await publisher.broadcastMessageInsert('byte-cohort-root', message('byte-prefix'));
  await firstStarted;
  const expected = Array.from({ length: 31 }, (_, index) => `byte-${index}`);
  await Promise.all(
    expected.map((id) =>
      publisher.broadcastMessageInsert('byte-cohort-root', message(id, 'x'.repeat(8210)))
    )
  );
  release(new Response('', { status: 202 }));
  await publisher.__flushBroadcastQueueForTests();
  assert.deepEqual(
    delivered,
    expected,
    'initial accounting overhead must split valid queued messages into bounded cohorts'
  );
  assert(
    sizes.length > 1,
    'the full admitted prefix must exceed the initial byte budget including overhead'
  );
  process.stdout.write('PASS unchanged byte caps include every cohort member overhead\n');
}

async function atomicAgeCutoff(publisher: Publisher): Promise<void> {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  let release!: (response: Response) => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sizes: number[] = [];
  globalThis.fetch = (async (_url, init) => {
    const batch = rows(init);
    if (batch[0].payload.record.id === 'age-prefix') {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    sizes.push(batch.length);
    return new Response('', { status: 202 });
  }) as typeof fetch;
  try {
    await publisher.broadcastMessageInsert('age-cohort-root', message('age-prefix'));
    await firstStarted;
    await Promise.all(
      Array.from({ length: 31 }, (_, index) =>
        publisher.broadcastMessageInsert('age-cohort-root', message(`age-${index}`))
      )
    );
    clock += 29_990;
    Date.now = () => clock++;
    release(new Response('', { status: 202 }));
    await publisher.__flushBroadcastQueueForTests();
    assert.deepEqual(
      sizes,
      [31],
      'crossing the age boundary while selecting members must keep the entire eligible cohort'
    );
    process.stdout.write('PASS one age cutoff per atomic cohort at the dispatch boundary\n');
  } finally {
    Date.now = realNow;
  }
}

async function occupiedInitialTopic(
  publisher: Publisher,
  bound: 'messages' | 'bytes'
): Promise<void> {
  const agent = `occupied-${bound}`;
  let release!: (response: Response) => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delivered: string[] = [];
  const durableSizes: number[] = [];
  globalThis.fetch = (async (_url, init) => {
    const batch = rows(init);
    if (batch[0].payload.record.id === `${agent}-prefix`) {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    const ids = batch.flatMap((row) => row.payload.record.id ?? []);
    durableSizes.push(ids.length);
    delivered.push(...ids);
    return new Response('', { status: 202 });
  }) as typeof fetch;
  await publisher.broadcastMessageInsert(agent, message(`${agent}-prefix`));
  await firstStarted;
  const expected = Array.from({ length: 31 }, (_, index) => `${agent}-${index}`);
  await Promise.all(
    expected.map((id) =>
      publisher.broadcastMessageInsert(
        agent,
        message(id, bound === 'bytes' ? 'x'.repeat(8000) : 'queued')
      )
    )
  );
  if (bound === 'messages') {
    await Promise.all(
      Array.from({ length: 48 }, (_, index) =>
        publisher.broadcastAgentUpdate(agent, { progress: index })
      )
    );
  } else {
    await publisher.broadcastToolEvent(
      agent,
      'occupied-stream',
      'occupied-tool',
      'web_search',
      'IN_PROGRESS',
      'x'.repeat(200_000)
    );
  }
  release(new Response('', { status: 202 }));
  await publisher.__flushBroadcastQueueForTests();
  assert.deepEqual(
    delivered,
    expected,
    'already queued ephemeral work must not make an admitted committed cohort reject'
  );
  assert(
    durableSizes.filter((size) => size > 0).length > 1,
    'cohort selection must use actual remaining initial capacity'
  );
  process.stdout.write(`PASS committed cohort respects occupied initial-topic ${bound} budget\n`);
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
