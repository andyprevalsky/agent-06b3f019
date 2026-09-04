#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import {
  assertFetchableExternalUrl,
  assertExternalHttpMethod,
  normalizeExternalHttpRequest,
} from '../../domains/external-http/validate';
import { InvalidExternalHttpRequestError } from '../../domains/external-http/errors';
import {
  assertPublicResolvedAddresses,
  executeExternalHttpRequest,
  redactExternalUrlForLogs,
} from '../../domains/external-http/service';

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
  for (const address of [
    '198.18.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '240.0.0.1',
    '2001:2::1',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
  ]) {
    const literalUrl = address.includes(':') ? `http://[${address}]/` : `http://${address}/`;
    assert.throws(
      () => assertFetchableExternalUrl(literalUrl),
      InvalidExternalHttpRequestError,
      address
    );
  }
  assert.equal(assertFetchableExternalUrl('https://8.8.8.8/'), 'https://8.8.8.8/');
  assert.equal(
    assertFetchableExternalUrl('https://[2001:4860:4860::8888]/'),
    'https://[2001:4860:4860::8888]/'
  );

  // A hostname that was public during an earlier validation must still fail
  // when the socket-time resolution has rebound to a private destination.
  assert.doesNotThrow(() =>
    assertPublicResolvedAddresses('rebind.example', [{ address: '8.8.8.8' }])
  );
  assert.throws(
    () => assertPublicResolvedAddresses('rebind.example', [{ address: '127.0.0.1' }]),
    InvalidExternalHttpRequestError
  );

  assert.equal(
    redactExternalUrlForLogs('https://user:pass@example.com/items?api_key=secret#token'),
    'https://example.com/items'
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

async function testRedirectSafety(): Promise<void> {
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    return new Response('', {
      status: 302,
      headers: { location: 'https://other.example/credential-sink' },
    });
  }) as typeof fetch;

  await assert.rejects(
    () =>
      executeExternalHttpRequest({
        method: 'POST',
        url: 'https://example.com/start',
        headers: { Authorization: 'Bearer secret' },
        body: { secret: true },
      }),
    /refuses cross-origin redirects/
  );
  assert.equal(callCount, 1);

  const observed: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => {
    observed.push(init ?? {});
    if (observed.length === 1) {
      return new Response('', { status: 302, headers: { location: '/done' } });
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const result = await executeExternalHttpRequest({
    method: 'POST',
    url: 'https://example.com/start',
    headers: { Authorization: 'Bearer same-origin', 'Content-Type': 'application/json' },
    body: { request: true },
  });
  assert.equal(result.ok, true);
  assert.equal(observed[0]?.method, 'POST');
  assert.equal(observed[1]?.method, 'GET');
  assert.equal(observed[1]?.body, undefined);
  assert.equal(new Headers(observed[1]?.headers).has('content-type'), false);
  assert.equal(new Headers(observed[1]?.headers).get('authorization'), 'Bearer same-origin');
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
  await testRedirectSafety();
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
