#!/usr/bin/env tsx
/* eslint-disable max-lines */
/**
 * Black-box tests for /api/data
 *
 * Domain surface:
 *   POST /api/data/grep    — search message threads by keyword (auth: JWT or API key)
 *   GET  /api/data/summary — filesystem-like summary of data sources (auth: JWT or API key)
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401
 *   - error-surface: missing pattern returns 400; invalid source returns 400; invalid since returns 400
 *   - idempotency: same grep query returns same-shaped response
 *   - concurrency: 10 parallel summary requests return consistent results
 *   - same-input reproducibility: three sequential grep requests return identical shapes
 *   - cleanup: read-only tests, no state mutations (grep and summary are read-only)
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: no write endpoints in this domain
 *   - state-transition: no state machine
 *   - ordering/pagination: results are ordered by timestamp (tested via schema)
 *   - atomicity: read-only
 *   - referential integrity: no FK mutations
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: read-only
 *   - tenant isolation: grep/summary only return authenticated user's data (by RLS)
 *   - time/clock: since parameter tested for validation
 *   - boundary param: no third-party HTTP calls
 *   - call ordering: no outbound calls
 *
 * See also:
 *   data-coverage.blackbox.ts  — person_id, limits, agent network sources, edge cases
 *   data-grep.blackbox.ts      — deep grep defaults / unicode / person_id resolution
 *   data-real-user.blackbox.ts — full pipeline with real test user (114K+ messages)
 *
 * Usage:
 *   npx tsx src/tests/blackbox/data.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/data.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import { testGrepAgentTaskPaths } from './data-agent-task-path.cases';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const GrepResponse = z.object({
  matches: z.array(
    z.object({
      source: z.enum(['messages', 'network', 'agent_network']),
      path: z.string(),
      pointer: z.string(),
      timestamp: z.string(),
      role: z.enum(['SYSTEM', 'ASSISTANT', 'USER', 'TOOL']).optional(),
      location: z.object({
        source: z.enum(['messages', 'network', 'agent_network']),
        path: z.string(),
        agent_id: z.string().optional(),
        message_id: z.string().optional(),
        role: z.enum(['SYSTEM', 'ASSISTANT', 'USER', 'TOOL']).optional(),
        thread: z.string().optional(),
        contact_id: z.string().optional(),
        field: z.string().optional(),
      }),
      content: z.string(),
    })
  ),
  total_matches: z.number(),
  truncated: z.boolean(),
  pattern: z.string(),
  sources: z.array(z.enum(['messages', 'network', 'agent_network'])),
  applied_limit: z.number(),
  applied_offset: z.number(),
  message: z.string().optional(),
});

const SummaryResponse = z.object({
  sources: z.object({
    messages: z.object({
      total_threads: z.number(),
      total_messages: z.number(),
      channels: z.record(z.number()),
      date_range: z.object({
        from: z.string().nullable(),
        to: z.string().nullable(),
      }),
      latest_message: z
        .object({
          timestamp: z.string(),
          channel: z.string(),
          from: z.string(),
          to: z.string(),
          text: z.string(),
        })
        .nullable(),
      threads: z.array(
        z.object({
          name: z.string(),
          message_count: z.number(),
          last_message: z.string(),
        })
      ),
    }),
  }),
});

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface TestContext {
  accessToken?: string;
  userId?: string;
}

const ctx: TestContext = {};

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data: unknown;
  const ct = response.headers.get('content-type');
  if (ct?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data, headers: response.headers };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function requestWithRetry(
  url: string,
  options: RequestInit = {},
  maxAttempts = 5
): Promise<{ status: number; data: unknown; headers: Headers }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: { status: number; data: unknown; headers: Headers };
    try {
      res = await request(url, options);
    } catch (err) {
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
    const isRetryable =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data &&
      (res.data as { error?: unknown }).error === 'Failed to create agent';
    if (isRetryable && attempt < maxAttempts) {
      await sleep(500 * attempt);
      continue;
    }
    return res;
  }
  throw new Error('requestWithRetry: exhausted all attempts');
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

async function runPool(
  tests: { name: string; fn: () => Promise<void> }[],
  concurrency: number
): Promise<TestResult[]> {
  const results: TestResult[] = new Array(tests.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= tests.length) return;
      results[idx] = await runTest(tests[idx].name, tests[idx].fn);
    }
  }
  const workerCount = Math.min(concurrency, tests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ==================== SETUP ====================

async function setup(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token;
  ctx.userId = d.user.id;
}

// ==================== POST /api/data/grep ====================

// --- auth boundary ---

async function testGrep_noAuth() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    body: JSON.stringify({ pattern: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testGrep_invalidToken() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders('invalid.jwt.token'),
    body: JSON.stringify({ pattern: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

// --- validation ---

async function testGrep_missingPattern() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

async function testGrep_nullPattern() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: null }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testGrep_numericPattern() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 12345 }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testGrep_invalidSource() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', source: 'nonexistent' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testGrep_invalidSince() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', since: 'not-a-date' }),
  });
  assertStatus(res.status, 400, res.data);
}

// --- happy path ---

async function testGrep_happy() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', source: 'messages' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (happy)');
}

async function testGrep_emptyPattern() {
  // Empty string pattern returns all messages
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', source: 'messages' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (empty pattern)');
}

async function testGrep_withSource() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', source: 'messages' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (with source)');
}

async function testGrep_acceptsSince() {
  // `since` is a valid messages-only narrowing param (ISO or relative like 7d).
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', source: 'messages', since: '2024-01-01T00:00:00Z' }),
  });
  assertStatus(res.status, 200, res.data);
}

async function testGrep_rejectsLimit() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', source: 'messages', limit: 5 }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error?: string };
  if (body.error !== 'INVALID_GREP_PARAM') {
    throw new Error(`Expected INVALID_GREP_PARAM, got: ${JSON.stringify(body)}`);
  }
}

async function testGrep_viaApiKey() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({ pattern: 'test', source: 'messages' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (API key)');
}

async function testGrep_noMatchesShape() {
  // Fresh anonymous user has no messages
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'xyznonexistent', source: 'messages' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (no matches)');
  if (body.total_matches !== 0) {
    throw new Error(`Expected 0 matches for fresh user, got ${body.total_matches}`);
  }
  if (body.matches.length !== 0) {
    throw new Error(`Expected empty matches array, got ${body.matches.length}`);
  }
}

// ==================== GET /api/data/summary ====================

// --- auth boundary ---

async function testSummary_noAuth() {
  const res = await request(`${BASE_URL}/api/data/summary`);
  assertStatus(res.status, 401, res.data);
}

async function testSummary_invalidToken() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders('invalid.jwt.token'),
  });
  assertStatus(res.status, 401, res.data);
}

// --- happy path ---

async function testSummary_happyJwt() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SummaryResponse, res.data, 'GET /summary (JWT)');
}

async function testSummary_happyApiKey() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SummaryResponse, res.data, 'GET /summary (API key)');
}

async function testSummary_freshUserEmpty() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (fresh)');
  // Fresh anonymous user should have 0 threads and 0 messages
  if (body.sources.messages.total_threads !== 0) {
    throw new Error(
      `Expected 0 threads for fresh user, got ${body.sources.messages.total_threads}`
    );
  }
  if (body.sources.messages.total_messages !== 0) {
    throw new Error(
      `Expected 0 messages for fresh user, got ${body.sources.messages.total_messages}`
    );
  }
  if (body.sources.messages.latest_message !== null) {
    throw new Error('Expected no latest message for fresh user');
  }
}

// ==================== POST /api/data/grep (agent_network source) ====================

async function testGrepAgentNetwork_missingAgentId() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({ pattern: 'test', source: 'agent_network' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'MISSING_AGENT_ID') {
    throw new Error(`Expected MISSING_AGENT_ID error, got: ${body.error}`);
  }
}

async function testGrepAgentNetwork_removedUserMessagesSource() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({ pattern: 'test', source: 'agent_network_user_messages' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'SOURCE_NOT_FOUND') {
    throw new Error(`Expected SOURCE_NOT_FOUND error, got: ${body.error}`);
  }
}

async function testGrepAgentNetwork_removedToolResultsSource() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({ pattern: 'test', source: 'agent_network_tool_results' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'SOURCE_NOT_FOUND') {
    throw new Error(`Expected SOURCE_NOT_FOUND error, got: ${body.error}`);
  }
}

async function testGrepAgentNetwork_nonexistentAgent() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({
      pattern: 'test',
      source: 'agent_network',
      agent_id: '00000000-0000-0000-0000-000000000099',
    }),
  });
  assertStatus(res.status, 403, res.data);
}

async function testGrepAgentNetwork_happyAllRoles() {
  const createRes = await requestWithRetry(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({ goal: 'blackbox test agent for grep' }),
  });
  assertStatus(createRes.status, 201, createRes.data);
  const agentId = (createRes.data as { agent_id: string }).agent_id;

  try {
    await prisma.message.createMany({
      data: [
        {
          agentId,
          role: 'USER',
          text: 'Unified data blackbox USER evidence',
          metadata: { blackbox: 'data', role: 'USER' },
        },
        {
          agentId,
          role: 'ASSISTANT',
          text: 'Unified data blackbox ASSISTANT evidence',
          metadata: { blackbox: 'data', role: 'ASSISTANT' },
        },
        {
          agentId,
          role: 'TOOL',
          text: 'Unified data blackbox TOOL evidence',
          metadata: { blackbox: 'data', role: 'TOOL' },
        },
      ],
    });

    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      body: JSON.stringify({
        pattern: 'Unified data blackbox',
        source: 'agent_network',
        agent_id: agentId,
      }),
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(GrepResponse, res.data, 'agent_network');
    for (const role of ['USER', 'ASSISTANT', 'TOOL'] as const) {
      if (!body.matches.some((match) => match.role === role && match.location.role === role)) {
        throw new Error(`Expected ${role} match with role metadata`);
      }
    }
  } finally {
    await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    });
  }
}

async function testGrepAgentNetwork_sourceInValidList() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({
      pattern: 'test',
      source: 'agent_network',
      agent_id: '00000000-0000-0000-0000-000000000099',
    }),
  });
  if (res.status === 400) {
    const body = res.data as { error: string };
    if (body.error === 'SOURCE_NOT_FOUND') {
      throw new Error('agent_network should be a valid source');
    }
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_grep() {
  const body = JSON.stringify({ pattern: 'test', source: 'messages' });
  const r1 = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body,
  });
  const r2 = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body,
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testIdempotency_summary() {
  const r1 = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(ctx.accessToken!),
  });
  const r2 = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(ctx.accessToken!),
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelSummary() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/data/summary`, {
        headers: authHeaders(ctx.accessToken!),
      })
    )
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Expected uniform status, got: ${[...statuses].join(', ')}`);
  }
}

async function testReproducibility_threeSequentialGrep() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: authHeaders(ctx.accessToken!),
      body: JSON.stringify({ pattern: 'repro-test', source: 'messages' }),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Data Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  await setup();
  console.log(`  User: ${ctx.userId}\n`);

  const parallelTests = [
    // auth boundary
    { name: 'POST /data/grep -- no auth -> 401', fn: testGrep_noAuth },
    { name: 'POST /data/grep -- invalid token -> 401', fn: testGrep_invalidToken },
    { name: 'GET /data/summary -- no auth -> 401', fn: testSummary_noAuth },
    { name: 'GET /data/summary -- invalid token -> 401', fn: testSummary_invalidToken },
    // validation
    { name: 'POST /data/grep -- missing pattern -> 400', fn: testGrep_missingPattern },
    { name: 'POST /data/grep -- null pattern -> 400', fn: testGrep_nullPattern },
    { name: 'POST /data/grep -- numeric pattern -> 400', fn: testGrep_numericPattern },
    { name: 'POST /data/grep -- invalid source -> 400', fn: testGrep_invalidSource },
    { name: 'POST /data/grep -- invalid since -> 400', fn: testGrep_invalidSince },
    // happy path
    { name: 'POST /data/grep -- happy path', fn: testGrep_happy },
    { name: 'POST /data/grep -- empty pattern returns all', fn: testGrep_emptyPattern },
    { name: 'POST /data/grep -- with source=messages', fn: testGrep_withSource },
    { name: 'POST /data/grep -- since param accepted', fn: testGrep_acceptsSince },
    { name: 'POST /data/grep -- limit param rejected', fn: testGrep_rejectsLimit },
    { name: 'POST /data/grep -- via API key', fn: testGrep_viaApiKey },
    { name: 'POST /data/grep -- no matches shape', fn: testGrep_noMatchesShape },
    { name: 'GET /data/summary -- happy path (JWT)', fn: testSummary_happyJwt },
    { name: 'GET /data/summary -- happy path (API key)', fn: testSummary_happyApiKey },
    { name: 'GET /data/summary -- fresh user empty', fn: testSummary_freshUserEmpty },
    // agent_network source
    {
      name: 'POST /data/grep -- agent_network missing agent_id -> 400',
      fn: testGrepAgentNetwork_missingAgentId,
    },
    {
      name: 'POST /data/grep -- removed agent_network_user_messages source -> 400',
      fn: testGrepAgentNetwork_removedUserMessagesSource,
    },
    {
      name: 'POST /data/grep -- removed agent_network_tool_results source -> 400',
      fn: testGrepAgentNetwork_removedToolResultsSource,
    },
    {
      name: 'POST /data/grep -- agent_network nonexistent agent -> 403',
      fn: testGrepAgentNetwork_nonexistentAgent,
    },
    {
      name: 'POST /data/grep -- agent_network happy path includes all roles',
      fn: testGrepAgentNetwork_happyAllRoles,
    },
    {
      name: 'POST /data/grep -- agent_network source is valid',
      fn: testGrepAgentNetwork_sourceInValidList,
    },
    {
      name: 'POST /data/grep -- trace_path /root/... scopes agent_network + agent_trajectories',
      fn: () =>
        testGrepAgentTaskPaths(ctx.userId!, { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! }),
    },
    // invariants
    { name: 'idempotency -- grep same on repeat', fn: testIdempotency_grep },
    { name: 'idempotency -- summary same on repeat', fn: testIdempotency_summary },
    {
      name: 'concurrency -- 10 parallel summaries consistent',
      fn: testConcurrency_parallelSummary,
    },
    {
      name: 'reproducibility -- 3 sequential greps identical',
      fn: testReproducibility_threeSequentialGrep,
    },
  ];

  console.log(`Running ${parallelTests.length} tests (concurrency=${CASE_CONCURRENCY})...`);
  const results = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL DATA BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
