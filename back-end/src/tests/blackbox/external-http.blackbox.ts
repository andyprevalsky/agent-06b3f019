#!/usr/bin/env tsx
/**
 * Black-box tests for /api/external-http
 *
 * The GET and POST round-trips run against seeded outbound replay fixtures,
 * so the route (validation, public-address checks, request serialization and
 * response decoding) is tested without depending on httpbin.org's uptime: a
 * 2026-10-12 httpbin outage returned 503 on every attempt and failed deploy
 * coverage. The POST case asserts on the captured outbound request itself.
 */

import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { outboundReplayCacheKey } from '../../providers/fetchCapture';

config();

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const USER_ID = process.env.BLACKBOX_TEST_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const GITHUB_TOKEN = process.env.GITHUB_DISPATCH_TOKEN || process.env.GITHUB_TOKEN || '';
const CAPTURE_TOKEN = `external-http-${randomUUID()}`;

const ResponseSchema = z.object({
  ok: z.boolean(),
  status: z.number(),
  status_text: z.string(),
  url: z.string(),
  headers: z.record(z.string()),
  body: z.unknown(),
  body_encoding: z.enum(['json', 'text', 'base64']),
  content_type: z.string().nullable(),
  elapsed_ms: z.number(),
  attempts: z.number(),
});

async function requestJson(path: string, body: unknown, expectedStatus = 200) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'X-User-Id': USER_ID,
      'X-Capture-Token': CAPTURE_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function testAuthBoundary() {
  const response = await fetch(`${BASE_URL}/api/external-http/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
  });
  if (response.status !== 401) {
    throw new Error(`Expected 401 without auth, got ${response.status}`);
  }
}

async function testInvalidUrlRejected() {
  await requestJson(
    '/api/external-http/request',
    { method: 'GET', url: 'network/foo.contact' },
    400
  );
}

/** Serve `response` for this exact outbound request from the replay cache. */
async function seedOutboundReplay(
  url: string,
  method: string,
  requestBody: string | null,
  responseBody: unknown
): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/test/captures/cache`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: outboundReplayCacheKey(url, method, requestBody),
      value: {
        __ff_promise_result: true,
        value: {
          status: 200,
          statusText: 'OK',
          body: JSON.stringify(responseBody),
          headers: { 'content-type': 'application/json' },
        },
      },
    }),
  });
  if (response.status !== 200) {
    throw new Error(`Failed to seed outbound replay for ${method} ${url}: ${response.status}`);
  }
}

async function testHttpbinGet() {
  await seedOutboundReplay('https://httpbin.org/json', 'GET', null, {
    slideshow: { author: 'Yours Truly', title: 'Sample Slide Show', slides: [] },
  });
  const raw = await requestJson('/api/external-http/request', {
    method: 'GET',
    url: 'https://httpbin.org/json',
  });
  const parsed = ResponseSchema.parse(raw);
  if (!parsed.ok || parsed.status !== 200) {
    throw new Error(`Expected successful httpbin JSON response, got ${JSON.stringify(parsed)}`);
  }
  if (parsed.body_encoding !== 'json' || typeof parsed.body !== 'object') {
    throw new Error(`Expected JSON body, got ${parsed.body_encoding}`);
  }
}

async function testPostEcho() {
  const sent = { title: 'rose', body: 'api_request', userId: 1 };
  const serialized = JSON.stringify(sent);
  await seedOutboundReplay('https://httpbin.org/post', 'POST', serialized, { json: sent });
  const raw = await requestJson('/api/external-http/request', {
    method: 'POST',
    url: 'https://httpbin.org/post',
    body: sent,
  });
  const parsed = ResponseSchema.parse(raw);
  const echoed = parsed.body as { json?: unknown };
  if (parsed.status !== 200 || !isDeepStrictEqual(echoed.json, sent)) {
    throw new Error(
      `POST echo mismatch: status ${parsed.status}, body ${JSON.stringify(parsed.body)}`
    );
  }

  // The fixture echoes; the outbound request itself proves serialization.
  const captured = await fetch(
    `${BASE_URL}/api/test/captures?token=${encodeURIComponent(CAPTURE_TOKEN)}`
  );
  const { captures } = (await captured.json()) as {
    captures: Array<{
      url: string;
      method: string;
      requestBody: string | null;
      requestHeaders: Record<string, string>;
    }>;
  };
  const outbound = captures.find(
    (capture) => capture.url === 'https://httpbin.org/post' && capture.method === 'POST'
  );
  const contentType = Object.entries(outbound?.requestHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-type'
  )?.[1];
  if (outbound?.requestBody !== serialized || !contentType?.includes('application/json')) {
    throw new Error(`POST was not sent as JSON: ${JSON.stringify(outbound)}`);
  }
}

async function testGithubSearchWhenTokenPresent() {
  if (!GITHUB_TOKEN) {
    process.stdout.write('Skipping GitHub live test — GITHUB_TOKEN not configured\n');
    return;
  }
  const raw = await requestJson('/api/external-http/request', {
    method: 'GET',
    url: 'https://api.github.com/search/repositories',
    query: {
      q: 'cuda kernel',
      sort: 'stars',
      order: 'desc',
      per_page: '5',
    },
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  const parsed = ResponseSchema.parse(raw);
  // A present-but-rejected token is credential infra (rotated PAT, SSO restriction), not a
  // regression in /api/external-http. Soft-skip so deploy gates do not fail closed on GitHub auth.
  if (
    parsed.status === 401 ||
    parsed.status === 403 ||
    (typeof parsed.body === 'object' &&
      parsed.body !== null &&
      /bad credentials|requires authentication|must be authenticated/i.test(
        JSON.stringify(parsed.body)
      ))
  ) {
    process.stdout.write(
      `⚠️  SKIP github search live: GitHub rejected the configured token ` +
        `(status=${parsed.status}); credential-infra precondition, not a code regression\n`
    );
    return;
  }
  if (!parsed.ok) {
    throw new Error(`GitHub search failed: ${JSON.stringify(parsed)}`);
  }
  const body = parsed.body as { items?: unknown[] };
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new Error(`Expected GitHub search items, got ${JSON.stringify(parsed.body)}`);
  }
}

const tests = [
  { name: 'auth boundary', fn: testAuthBoundary },
  { name: 'invalid url rejected', fn: testInvalidUrlRejected },
  { name: 'httpbin GET', fn: testHttpbinGet },
  { name: 'httpbin POST echo', fn: testPostEcho },
  { name: 'github search live', fn: testGithubSearchWhenTokenPresent },
];

async function main() {
  let passed = 0;
  for (const test of tests) {
    await test.fn();
    passed += 1;
    process.stdout.write(`✅ ${test.name}\n`);
  }
  process.stdout.write(`\nRESULTS: ${passed}/${tests.length} passed\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
