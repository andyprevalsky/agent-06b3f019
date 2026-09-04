#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import {
  assertFetchableExternalUrl,
  assertExternalHttpMethod,
  normalizeExternalHttpRequest,
} from '../../domains/external-http/validate';
import { InvalidExternalHttpRequestError } from '../../domains/external-http/errors';
import { executeExternalHttpRequest } from '../../domains/external-http/service';

const originalFetch = globalThis.fetch;

function jsonResponse(
  payload: unknown,
  init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function testValidation(): Promise<void> {
  assert.equal(assertExternalHttpMethod('get'), 'GET');
  assert.throws(() => assertExternalHttpMethod('TRACE'), InvalidExternalHttpRequestError);
  assert.equal(
    assertFetchableExternalUrl('https://api.github.com/search/repositories'),
    'https://api.github.com/search/repositories'
  );
  assert.throws(
    () => assertFetchableExternalUrl('network/foo.contact'),
    InvalidExternalHttpRequestError
  );
  assert.throws(
    () => assertFetchableExternalUrl('http://localhost:8080/secret'),
    InvalidExternalHttpRequestError
  );
  assert.throws(
    () => assertFetchableExternalUrl('http://127.0.0.1/'),
    InvalidExternalHttpRequestError
  );
  assert.throws(
    () => assertFetchableExternalUrl('http://169.254.169.254/latest/meta-data/'),
    InvalidExternalHttpRequestError
  );

  const normalized = normalizeExternalHttpRequest({
    method: 'post',
    url: 'https://example.com/data',
    query: { page: 2, active: true },
    headers: { Authorization: 'Bearer test' },
    body: { q: 'cuda' },
  });
  assert.equal(normalized.method, 'POST');
  assert.deepEqual(normalized.headers, { Authorization: 'Bearer test' });
}

async function testSuccessfulJsonResponse(): Promise<void> {
  let callCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    callCount += 1;
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assert.match(url, /example\.com\/repos\?page=2&sort=stars/);
    assert.equal(init?.method, 'GET');
    assert.equal(
      init?.headers instanceof Headers ? init.headers.get('authorization') : null,
      'Bearer abc'
    );
    return jsonResponse({ items: [{ full_name: 'org/repo', stargazers_count: 10 }] });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/repos',
    query: { page: 2, sort: 'stars' },
    headers: { Authorization: 'Bearer abc' },
  });

  assert.equal(callCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.body_encoding, 'json');
  assert.deepEqual(result.body, { items: [{ full_name: 'org/repo', stargazers_count: 10 }] });
}

async function testRetryOn429(): Promise<void> {
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      return jsonResponse(
        { message: 'rate limited' },
        { status: 429, headers: { 'retry-after': '0' } }
      );
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/rate-limit',
  });

  assert.equal(callCount, 2);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
}

async function testRetryOn503(): Promise<void> {
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    if (callCount <= 2) {
      return jsonResponse({ message: 'unavailable' }, { status: 503 });
    }
    return jsonResponse({ recovered: true });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/unavailable',
  });

  assert.equal(callCount, 3);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
}

async function testNoRetryOn401(): Promise<void> {
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    return jsonResponse({ message: 'Bad credentials' }, { status: 401 });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/unauthorized',
    headers: { Authorization: 'Bearer bad' },
  });

  assert.equal(callCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.attempts, 1);
}

async function testLargeJsonBodyNotTruncated(): Promise<void> {
  const items = Array.from({ length: 120 }, (_, index) => ({
    id: index,
    full_name: `org/repo-${index}`,
    description: 'x'.repeat(500),
    stargazers_count: 10_000 - index,
  }));

  globalThis.fetch = (async () =>
    jsonResponse({ total_count: items.length, items })) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/large-json',
  });

  assert.equal(result.body_encoding, 'json');
  const body = result.body as { items: Array<{ id: number }> };
  assert.equal(body.items.length, 120);
  assert.equal(body.items[119].id, 119);
  assert.match(String(body.items[0].description), /^x{500}$/);
}

async function testTextXmlAndBinaryResponses(): Promise<void> {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/text')) {
      return new Response('plain text body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url.includes('/xml')) {
      return new Response('<root><item>1</item></root>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    return new Response(Buffer.from([0x00, 0x01, 0x02]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }) as typeof fetch;

  const text = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/text',
  });
  assert.equal(text.body_encoding, 'text');
  assert.equal(text.body, 'plain text body');

  const xml = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/xml',
  });
  assert.equal(xml.body_encoding, 'text');
  assert.match(String(xml.body), /<root>/);

  const binary = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/binary',
  });
  assert.equal(binary.body_encoding, 'base64');
  assert.equal(binary.body, Buffer.from([0x00, 0x01, 0x02]).toString('base64'));
}

async function testPostJsonBody(): Promise<void> {
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.equal(
      init?.headers instanceof Headers ? init.headers.get('content-type') : null,
      'application/json; charset=utf-8'
    );
    assert.equal(init?.body, JSON.stringify({ q: 'cuda' }));
    return jsonResponse({ total_count: 1 });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'POST',
    url: 'https://example.com/search',
    body: { q: 'cuda' },
  });
  assert.deepEqual(result.body, { total_count: 1 });
}

async function testPostDoesNotRetryWithoutIdempotencyKey(): Promise<void> {
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    return jsonResponse({ message: 'unavailable' }, { status: 503 });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'POST',
    url: 'https://example.com/mutate',
    body: { action: 'create' },
  });

  assert.equal(callCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.attempts, 1);
}

async function testRedirectsAreFollowedAndRevalidated(): Promise<void> {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.endsWith('/start')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/final' },
      });
    }
    return jsonResponse({ landed: true });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/start',
  });
  assert.deepEqual(urls, ['https://example.com/start', 'https://example.com/final']);
  assert.deepEqual(result.body, { landed: true });
}

async function testEmptyBodyAndInvalidJsonFallback(): Promise<void> {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/empty')) {
      return new Response(null, { status: 204 });
    }
    return new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const empty = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/empty',
  });
  assert.equal(empty.body, '');
  assert.equal(empty.body_encoding, 'text');

  const invalid = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/invalid-json',
  });
  assert.equal(invalid.body_encoding, 'text');
  assert.equal(invalid.body, 'not-json');
}

async function testStringPostBodyAndIdempotentRetry(): Promise<void> {
  let postCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    postCalls += 1;
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, 'raw body');
    if (postCalls === 1) {
      return jsonResponse(
        { message: 'unavailable' },
        { status: 503, headers: { 'retry-after': new Date(Date.now() - 1000).toUTCString() } }
      );
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'POST',
    url: 'https://example.com/raw',
    headers: { 'Idempotency-Key': 'k1' },
    body: 'raw body',
  });
  assert.equal(postCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
}

async function testTransportErrorThenSuccess(): Promise<void> {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('ECONNRESET');
    }
    return jsonResponse({ recovered: true });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://example.com/flaky',
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.body, { recovered: true });
}

async function testOversizeDeclaredContentLength(): Promise<void> {
  globalThis.fetch = (async () =>
    new Response('tiny', {
      status: 200,
      headers: { 'content-length': String(20 * 1024 * 1024) },
    })) as typeof fetch;

  await assert.rejects(
    () =>
      executeExternalHttpRequest({
        method: 'GET',
        url: 'https://example.com/huge',
      }),
    /exceeds/
  );
}

async function testPublicIpSkipsDnsAndEmptyRedirectStops(): Promise<void> {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('loop', {
      status: 302,
      headers: { location: '   ', 'content-type': 'text/plain' },
    });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'GET',
    url: 'https://1.1.1.1/health',
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 302);
  assert.equal(result.body, 'loop');
}

async function testTooManyRedirects(): Promise<void> {
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/next' },
    })) as typeof fetch;

  await assert.rejects(
    () =>
      executeExternalHttpRequest({
        method: 'GET',
        url: 'https://example.com/bounce',
      }),
    /exceeded/
  );
}

async function testHeadAndPostWithoutBody(): Promise<void> {
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.body, undefined);
    return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;

  const head = await executeExternalHttpRequest({
    method: 'HEAD',
    url: 'https://example.com/head',
  });
  assert.equal(head.status, 200);

  const post = await executeExternalHttpRequest({
    method: 'POST',
    url: 'https://example.com/nobody',
  });
  assert.equal(post.status, 200);
}

async function testDnsFailureAndExhaustedTransportError(): Promise<void> {
  await assert.rejects(
    () =>
      executeExternalHttpRequest({
        method: 'GET',
        url: 'https://no-such-host-xyz.invalid/path',
      }),
    /DNS lookup failed/
  );

  globalThis.fetch = (async () => {
    throw new Error('ECONNRESET');
  }) as typeof fetch;

  await assert.rejects(
    () =>
      executeExternalHttpRequest({
        method: 'GET',
        url: 'https://example.com/down',
      }),
    /ECONNRESET/
  );
}

async function main(): Promise<void> {
  await testValidation();
  await testSuccessfulJsonResponse();
  await testRetryOn429();
  await testRetryOn503();
  await testNoRetryOn401();
  await testLargeJsonBodyNotTruncated();
  await testTextXmlAndBinaryResponses();
  await testPostJsonBody();
  await testPostDoesNotRetryWithoutIdempotencyKey();
  await testRedirectsAreFollowedAndRevalidated();
  await testEmptyBodyAndInvalidJsonFallback();
  await testStringPostBodyAndIdempotentRetry();
  await testTransportErrorThenSuccess();
  await testOversizeDeclaredContentLength();
  await testPublicIpSkipsDnsAndEmptyRedirectStops();
  await testTooManyRedirects();
  await testHeadAndPostWithoutBody();
  await testDnsFailureAndExhaustedTransportError();
  process.stdout.write('external-http unit tests passed\n');
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
