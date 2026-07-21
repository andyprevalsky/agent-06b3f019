#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  installFetchCapture,
  isRetryableOutboundResponseStatus,
  outboundReplayCacheKey,
  shouldBypassOutboundReplay,
} from '../../providers/fetchCapture';

async function run(): Promise<void> {
  assert.strictEqual(isRetryableOutboundResponseStatus(429), true);
  assert.strictEqual(isRetryableOutboundResponseStatus(500), true);
  assert.strictEqual(isRetryableOutboundResponseStatus(503), true);
  assert.strictEqual(isRetryableOutboundResponseStatus(404), false);
  assert.strictEqual(shouldBypassOutboundReplay('https://amplitude.com/api/2/funnels'), true);
  assert.strictEqual(
    shouldBypassOutboundReplay('https://analytics.eu.amplitude.com/api/2/funnels'),
    true
  );

  const originalFetch = globalThis.fetch;
  const previousReplay = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
  const url = `https://retry-cache-test.example/fresh-${process.pid}-${randomUUID()}`;
  const calls = new Map<string, number>();
  const cacheKey = outboundReplayCacheKey(url, 'GET', null);
  const cacheFile = resolve(
    __dirname,
    '../../../../.context/fast-forward-cache/outbound-fetch',
    `${createHash('sha256').update(cacheKey).digest('hex')}.json`
  );
  assert.match(cacheKey, /^call:\[/);

  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const requestedUrl = String(input);
    const callCount = (calls.get(requestedUrl) ?? 0) + 1;
    calls.set(requestedUrl, callCount);
    if (callCount === 1) {
      return new Response('{"error":"live rate limit"}', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = '1';
  installFetchCapture();

  try {
    assert.strictEqual((await fetch(url)).status, 429);
    assert.strictEqual((await fetch(url)).status, 200);
    assert.strictEqual((await fetch(url)).status, 200);
    assert.strictEqual(
      calls.get(url),
      2,
      'a live 429 must not be cached while the following success remains replayable'
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousReplay === undefined) delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
    else process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = previousReplay;
    await delay(100);
    if (existsSync(cacheFile)) unlinkSync(cacheFile);
  }

  process.stdout.write('fetch-capture retry cache tests passed\n');
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
