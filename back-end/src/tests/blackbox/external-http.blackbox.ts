#!/usr/bin/env tsx
/**
 * Black-box tests for /api/external-http
 */

import { config } from 'dotenv';
import { z } from 'zod';

config();

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const USER_ID = process.env.BLACKBOX_TEST_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const GITHUB_TOKEN = process.env.GITHUB_DISPATCH_TOKEN || process.env.GITHUB_TOKEN || '';

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

async function testJsonPlaceholderGet() {
  const raw = await requestJson('/api/external-http/request', {
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/todos/1',
  });
  const parsed = ResponseSchema.parse(raw);
  if (!parsed.ok || parsed.status !== 200) {
    throw new Error(`Expected successful JSON placeholder response, got ${JSON.stringify(parsed)}`);
  }
  if (parsed.body_encoding !== 'json' || typeof parsed.body !== 'object') {
    throw new Error(`Expected JSON body, got ${parsed.body_encoding}`);
  }
}

async function testPostEcho() {
  const raw = await requestJson('/api/external-http/request', {
    method: 'POST',
    url: 'https://jsonplaceholder.typicode.com/posts',
    body: { title: 'rose', body: 'api_request', userId: 1 },
  });
  const parsed = ResponseSchema.parse(raw);
  if (parsed.status !== 201 && parsed.status !== 200) {
    throw new Error(`Unexpected POST status ${parsed.status}`);
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
  { name: 'jsonplaceholder GET', fn: testJsonPlaceholderGet },
  { name: 'jsonplaceholder POST', fn: testPostEcho },
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
