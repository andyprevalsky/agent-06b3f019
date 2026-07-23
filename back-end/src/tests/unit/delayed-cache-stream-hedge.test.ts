#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import {
  delayedCacheStreamHedge,
  type CacheLookupResult,
} from '../../providers/chat/delayedCacheStreamHedge';

interface Chunk {
  content?: string;
  reasoning?: string;
  marker: string;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function collect(iterable: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function stream(chunks: Chunk[]): AsyncIterable<Chunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function hedge(options: {
  cache: Promise<CacheLookupResult<string>>;
  createLive: (signal: AbortSignal) => Promise<AsyncIterable<Chunk>>;
  graceMs?: number;
  errors?: unknown[];
  winners?: string[];
}): AsyncIterable<Chunk> {
  return delayedCacheStreamHedge({
    readCache: () => options.cache,
    createLive: options.createLive,
    createCached: (value) => stream([{ content: value, marker: 'cache' }]),
    isLiveCommitChunk: (chunk) => Boolean(chunk.content || chunk.reasoning),
    graceMs: options.graceMs ?? 10,
    onCacheError: (error) => options.errors?.push(error),
    onWinner: (winner) => options.winners?.push(winner),
  });
}

async function testHotHitAvoidsLiveConstruction(): Promise<void> {
  let liveConstructions = 0;
  const chunks = await collect(
    hedge({
      cache: Promise.resolve({ hit: true, value: 'cached-json' }),
      createLive: async () => {
        liveConstructions += 1;
        return stream([{ content: 'live-json', marker: 'live' }]);
      },
    })
  );

  assert.deepEqual(chunks, [{ content: 'cached-json', marker: 'cache' }]);
  assert.equal(liveConstructions, 0);
}

async function testEarlyMissStartsLiveImmediately(): Promise<void> {
  let liveConstructions = 0;
  const startedAt = Date.now();
  const chunks = await collect(
    hedge({
      cache: Promise.resolve({ hit: false }),
      graceMs: 100,
      createLive: async () => {
        liveConstructions += 1;
        return stream([{ content: 'live-json', marker: 'live' }]);
      },
    })
  );

  assert.deepEqual(chunks, [{ content: 'live-json', marker: 'live' }]);
  assert.equal(liveConstructions, 1);
  assert.ok(Date.now() - startedAt < 80, 'cache miss must not consume the grace window');
}

async function testSlowMissNeverGatesFirstLiveChunk(): Promise<void> {
  const cache = deferred<CacheLookupResult<string>>();
  const winners: string[] = [];
  const liveChunks = collect(
    hedge({
      cache: cache.promise,
      graceMs: 5,
      winners,
      createLive: async () => stream([{ content: 'first-live', marker: 'live' }]),
    })
  );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    liveChunks.then((chunks) => ({ kind: 'live' as const, chunks })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      watchdog = setTimeout(() => resolve({ kind: 'timeout' }), 1_000);
    }),
  ]);
  if (watchdog) clearTimeout(watchdog);

  assert.equal(outcome.kind, 'live', 'unresolved cache lookup must not gate live content');
  if (outcome.kind !== 'live') return;
  assert.deepEqual(outcome.chunks, [{ content: 'first-live', marker: 'live' }]);
  assert.deepEqual(winners, ['live']);
  cache.resolve({ hit: false });
}

async function testCacheCanWinAfterGraceBeforeLiveContent(): Promise<void> {
  const cache = deferred<CacheLookupResult<string>>();
  const liveChunk = deferred<IteratorResult<Chunk>>();
  let aborted = false;
  let returned = false;

  const chunksPromise = collect(
    hedge({
      cache: cache.promise,
      graceMs: 1,
      createLive: async (signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          liveChunk.resolve({ done: true, value: undefined });
        });
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => liveChunk.promise,
              return: async () => {
                returned = true;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  cache.resolve({ hit: true, value: 'cached-after-grace' });
  assert.deepEqual(await chunksPromise, [{ content: 'cached-after-grace', marker: 'cache' }]);
  assert.equal(aborted, true, 'cache winner must abort the provider request');
  assert.equal(returned, true, 'cache winner must close the provider iterator');
}

async function testLiveWinnerLocksOutLateCacheWithoutSplicing(): Promise<void> {
  const cache = deferred<CacheLookupResult<string>>();
  const chunksPromise = collect(
    hedge({
      cache: cache.promise,
      graceMs: 1,
      createLive: async () =>
        stream([
          { marker: 'metadata' },
          { reasoning: 'thinking', marker: 'reasoning' },
          { content: 'live-json', marker: 'content' },
        ]),
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  cache.resolve({ hit: true, value: 'late-cache' });
  const chunks = await chunksPromise;
  assert.deepEqual(
    chunks.map((chunk) => chunk.marker),
    ['metadata', 'reasoning', 'content'],
    'all chunks must come from one stream'
  );
}

async function testCacheErrorIsObservedAndStartsLive(): Promise<void> {
  const expected = new Error('cache unavailable');
  const errors: unknown[] = [];
  const chunks = await collect(
    hedge({
      cache: Promise.reject(expected),
      graceMs: 100,
      errors,
      createLive: async () => stream([{ content: 'live-json', marker: 'live' }]),
    })
  );

  assert.deepEqual(chunks, [{ content: 'live-json', marker: 'live' }]);
  assert.deepEqual(errors, [expected]);
}

async function testProviderErrorBeforeContentPropagates(): Promise<void> {
  const expected = new Error('provider failed before content');
  const cache = deferred<CacheLookupResult<string>>();
  const iterable = hedge({
    cache: cache.promise,
    graceMs: 1,
    createLive: async () =>
      (async function* () {
        yield { marker: 'metadata' };
        throw expected;
      })(),
  });

  await assert.rejects(collect(iterable), expected);
  cache.resolve({ hit: true, value: 'must-not-mask-provider-error' });
}

async function main(): Promise<void> {
  await testHotHitAvoidsLiveConstruction();
  await testEarlyMissStartsLiveImmediately();
  await testSlowMissNeverGatesFirstLiveChunk();
  await testCacheCanWinAfterGraceBeforeLiveContent();
  await testLiveWinnerLocksOutLateCacheWithoutSplicing();
  await testCacheErrorIsObservedAndStartsLive();
  await testProviderErrorBeforeContentPropagates();
  process.stdout.write('delayed-cache-stream-hedge tests passed\n');
}

void main();
