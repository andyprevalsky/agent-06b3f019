#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { MAX_BACKOFF_DELAY_MS, retryWithBackoff, type RetryOptions } from '../../providers/retry';

type TimerFn = typeof globalThis.setTimeout;

const realSetTimeout: TimerFn = globalThis.setTimeout;

/**
 * Record every delay handed to `setTimeout` during a retry run, firing each
 * timer immediately so an intentionally huge delay never stalls the test.
 */
async function scheduledDelays(opts: RetryOptions): Promise<number[]> {
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number) => {
    delays.push(Number(ms));
    return realSetTimeout(handler, 0);
  }) as unknown as TimerFn;
  try {
    await assert.rejects(
      retryWithBackoff(() => Promise.reject(new TypeError('retryable failure')), opts)
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return delays;
}

async function run(): Promise<void> {
  assert.equal(
    MAX_BACKOFF_DELAY_MS,
    2_147_483_647,
    "the clamp must match Node's signed 32-bit timer ceiling"
  );

  // A provider-derived delay (e.g. a parsed Retry-After header) can be garbage.
  // setTimeout silently turns a non-finite delay into a 1ms timer, which would
  // convert a rate-limit backoff into a hot retry loop.
  for (const [label, value] of [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ] as const) {
    assert.deepEqual(
      await scheduledDelays({
        maxRetries: 3,
        initialBackoffMs: 10,
        getBackoffDelayMs: () => value,
      }),
      [10, 20],
      `a ${label} dynamic delay must be rejected in favour of bounded exponential backoff`
    );
  }

  assert.deepEqual(
    await scheduledDelays({ maxRetries: 2, getBackoffDelayMs: () => -5000 }),
    [0],
    'a negative dynamic delay must clamp to 0, never schedule a negative timer'
  );

  assert.deepEqual(
    await scheduledDelays({ maxRetries: 2, getBackoffDelayMs: () => 1e21 }),
    [MAX_BACKOFF_DELAY_MS],
    'a delay past the timer ceiling must clamp instead of collapsing to a 1ms timer'
  );

  assert.deepEqual(
    await scheduledDelays({
      maxRetries: 3,
      getBackoffDelayMs: (_error, attempt) => attempt * 1234,
    }),
    [1234, 2468],
    'valid dynamic delays must pass through unchanged'
  );

  assert.deepEqual(
    await scheduledDelays({ maxRetries: 4, initialBackoffMs: 10, fixedDelays: [Number.NaN, 50] }),
    [10, 50, 40],
    'an invalid fixed delay falls back to exponential while valid entries are honored'
  );

  assert.deepEqual(
    await scheduledDelays({ maxRetries: 2, initialBackoffMs: Number.POSITIVE_INFINITY }),
    [1000],
    'a non-finite configured base must fall back to the documented 1000ms default'
  );

  assert.deepEqual(
    await scheduledDelays({ maxRetries: 3, initialBackoffMs: MAX_BACKOFF_DELAY_MS }),
    [MAX_BACKOFF_DELAY_MS, MAX_BACKOFF_DELAY_MS],
    'exponential growth must saturate at the timer ceiling rather than overflow'
  );

  assert.deepEqual(
    await scheduledDelays({ maxRetries: 3, initialBackoffMs: 10 }),
    [10, 20],
    'ordinary exponential backoff semantics must be preserved'
  );

  process.stdout.write('PASS retry bounds every scheduled backoff delay\n');
}

void run();
