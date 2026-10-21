#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import express from 'express';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  installFetchCapture,
  isRetryableOutboundResponseStatus,
  outboundReplayCacheKey,
  shouldBypassOutboundReplay,
} from '../../providers/fetchCapture';

async function testCredentialExchanges(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const previousReplay = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
  const secret = `fake-capture-secret-${randomUUID()}`;
  const calls = new Map<string, number>();
  const files = new Set<string>();
  const body = new URLSearchParams({ refresh_token: secret });
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === '127.0.0.1') return originalFetch(input, init);
    if (new URL(url).pathname === '/v1/operations/people_search') {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      return new Response(JSON.stringify({ results: [{ name: 'Ada' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    assert.equal(
      String(init?.body),
      body.toString(),
      'credential request must pass through unchanged'
    );
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
    const count = (calls.get(url) ?? 0) + 1;
    calls.set(url, count);
    return new Response(
      JSON.stringify({ access_token: `${secret}-${count}`, refresh_token: secret }),
      {
        headers: { 'content-type': 'application/json' },
      }
    );
  }) as typeof fetch;
  process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = '1';
  const app = express();
  app.use('/captures', installFetchCapture());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  let cleanupError: unknown;
  try {
    for (const path of [
      '/oauth/token',
      '/api/integrations/lantern-people/credentials/token',
      '/api/integrations/lantern-people/credentials/upload',
    ]) {
      const url = `https://credential-${randomUUID()}.example.test${path}?refresh_hint=${secret}`;
      const legacyKey = `call:${JSON.stringify([url, 'POST', body.toString()])}`;
      const safeKey = outboundReplayCacheKey(url, 'POST', body.toString());
      for (const key of [legacyKey, safeKey]) {
        files.add(
          resolve(
            __dirname,
            '../../../../.context/fast-forward-cache/outbound-fetch',
            `${createHash('sha256').update(key).digest('hex')}.json`
          )
        );
      }
      const init = { method: 'POST', body, headers: { Authorization: `Bearer ${secret}` } };
      const first = (await (await fetch(url, init)).json()) as { access_token: string };
      const metadata = await (await originalFetch(`${base}/captures`)).json();
      assert(
        !JSON.stringify(metadata).includes(secret),
        'credential material entered capture metadata'
      );
      const second = (await (await fetch(url, init)).json()) as { access_token: string };
      assert.equal(first.access_token, `${secret}-1`);
      assert.equal(second.access_token, `${secret}-2`, 'rotating token exchange was replayed');
      assert.equal(calls.get(url), 2);
      assert(!safeKey.includes(secret), 'credential material entered replay cache key');
    }
    const searchUrl = `https://people-${randomUUID()}.example.test/v1/operations/people_search?next=/oauth/token`;
    const searchBody = JSON.stringify({ query: 'founders' });
    const searchKey = outboundReplayCacheKey(searchUrl, 'POST', searchBody);
    const searchFile = resolve(
      __dirname,
      '../../../../.context/fast-forward-cache/outbound-fetch',
      `${createHash('sha256').update(searchKey).digest('hex')}.json`
    );
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(
        await (
          await fetch(searchUrl, {
            method: 'POST',
            body: searchBody,
            headers: { Authorization: `Bearer ${secret}` },
          })
        ).json(),
        { results: [{ name: 'Ada' }] }
      );
    }
    assert.equal(calls.get(searchUrl), 1, 'ordinary people search replay changed');
    const searchCaptures = (await (await originalFetch(`${base}/captures`)).json()) as {
      captures: Array<{
        url: string;
        requestBody: string | null;
        responseBody: string | null;
        requestHeaders: Record<string, string>;
      }>;
    };
    const searchCapture = searchCaptures.captures.find((item) => item.url === searchUrl);
    assert.equal(searchCapture?.requestBody, searchBody);
    assert.equal(searchCapture?.responseBody, JSON.stringify({ results: [{ name: 'Ada' }] }));
    assert.equal(searchCapture?.requestHeaders.Authorization, '[redacted]');
    const captured = (await (await originalFetch(`${base}/captures`)).json()) as {
      captures: unknown[];
    };
    assert(
      !JSON.stringify(captured).includes(secret),
      'credential material entered capture metadata'
    );
    await delay(100);
    for (const file of files)
      assert(!existsSync(file), 'credential exchange persisted to disk cache');
    files.add(searchFile);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousReplay === undefined) delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
    else process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = previousReplay;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await delay(100);
    for (const file of files) {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError = error;
      }
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
}

async function testCompletionOrderedCredentialCursor(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const previousReplay = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
  const secret = `fake-pagination-secret-${randomUUID()}`;
  const slowUrl = `https://slow-${randomUUID()}.example.test/oauth/token?hint=${secret}`;
  const fastUrl = `https://fast-${randomUUID()}.example.test/oauth/token?hint=${secret}`;
  let releaseSlow: () => void = () => assert.fail('slow barrier was not initialized');
  let signalStarted: () => void = () => assert.fail('start barrier was not initialized');
  const slowBarrier = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === '127.0.0.1') return originalFetch(input, init);
    if (url === slowUrl) {
      signalStarted();
      await slowBarrier;
    } else assert.equal(url, fastUrl);
    return new Response(JSON.stringify({ access_token: secret }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = '0';
  const app = express();
  app.use('/captures', installFetchCapture());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  let slow: Promise<Response> | undefined;
  try {
    await originalFetch(`${base}/captures`, { method: 'DELETE' });
    slow = fetch(slowUrl, { method: 'POST', body: secret });
    await started;
    await fetch(fastUrl, { method: 'POST', body: secret });
    const first = (await (await originalFetch(`${base}/captures`)).json()) as {
      captures: Array<{ id: number; url: string }>;
    };
    assert.equal(first.captures.length, 1);
    assert.equal(first.captures[0].url, fastUrl.split('?')[0]);
    releaseSlow();
    await slow;
    const later = (await (
      await originalFetch(`${base}/captures?after=${first.captures[0].id}`)
    ).json()) as { captures: Array<{ id: number; url: string }> };
    assert.deepEqual(
      later.captures.map((entry) => entry.url),
      [slowUrl.split('?')[0]],
      'a late-completing credential exchange was lost after the visible capture cursor'
    );
    assert(later.captures[0].id > first.captures[0].id);
    assert(!JSON.stringify([first, later]).includes(secret));
  } finally {
    releaseSlow();
    await slow?.catch(() => undefined);
    globalThis.fetch = originalFetch;
    if (previousReplay === undefined) delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
    else process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = previousReplay;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

/** A captured 204/205 must come back with a null body: `new Response('', { status: 204 })` throws. */
async function testNullBodyStatusesSurviveCapture(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const previousReplay = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
  const files: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return new Response(null, { status: url.includes('/reset') ? 205 : 204 });
  }) as typeof fetch;
  process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = '1';
  const app = express();
  app.use('/captures', installFetchCapture());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    for (const [path, status] of [
      ['/v1/session/sess_released', 204],
      ['/v1/reset', 205],
    ] as const) {
      const url = `https://null-body-${randomUUID()}.example.test${path}`;
      files.push(
        resolve(
          __dirname,
          '../../../../.context/fast-forward-cache/outbound-fetch',
          `${createHash('sha256')
            .update(outboundReplayCacheKey(url, 'DELETE', null))
            .digest('hex')}.json`
        )
      );
      const response = await fetch(url, { method: 'DELETE' });
      assert.equal(response.status, status, `captured ${status} changed status`);
      assert.equal(await response.text(), '', `captured ${status} grew a body`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousReplay === undefined) delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
    else process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = previousReplay;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await delay(100);
    for (const file of files) if (existsSync(file)) unlinkSync(file);
  }
}

async function run(): Promise<void> {
  await testCompletionOrderedCredentialCursor();
  await testNullBodyStatusesSurviveCapture();
  await testCredentialExchanges();
  assert.strictEqual(isRetryableOutboundResponseStatus(429), true);
  assert.strictEqual(isRetryableOutboundResponseStatus(500), true);
  assert.strictEqual(isRetryableOutboundResponseStatus(503), true);
  assert.strictEqual(isRetryableOutboundResponseStatus(404), false);
  assert.strictEqual(shouldBypassOutboundReplay('https://amplitude.com/api/2/funnels'), true);
  assert.strictEqual(
    shouldBypassOutboundReplay('https://analytics.eu.amplitude.com/api/2/funnels'),
    true
  );
  // Tilion creates paid browsers: a replayed POST /v1/session returns a long-dead
  // session id, which then fails CDP validation on every live blackbox create.
  assert.strictEqual(shouldBypassOutboundReplay('https://back.tilion.dev/v1/session'), true);
  const previousTilionBase = process.env.TILION_BASE_URL;
  process.env.TILION_BASE_URL = 'https://tilion-staging.example.test/';
  try {
    assert.strictEqual(
      shouldBypassOutboundReplay('https://tilion-staging.example.test/v1/sessions'),
      true
    );
  } finally {
    if (previousTilionBase === undefined) delete process.env.TILION_BASE_URL;
    else process.env.TILION_BASE_URL = previousTilionBase;
  }
  assert.strictEqual(shouldBypassOutboundReplay('https://tilion.dev.example.test/'), false);

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

  let cleanupError: unknown;
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
    // Best-effort cleanup. The outbound-fetch NonBlockingFileCache namespace is
    // shared across concurrent unit workers, so a sibling test clearing the
    // namespace can remove this uniquely-named file between an existsSync check
    // and the unlink. Tolerate that race instead of guarding with existsSync
    // (which is itself a TOCTOU window) — the assertions above are the test.
    // Defer any non-ENOENT throw until after finally so no-unsafe-finally does
    // not swallow the original assertion error.
    try {
      unlinkSync(cacheFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError = error;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;

  process.stdout.write('fetch-capture retry cache tests passed\n');
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
