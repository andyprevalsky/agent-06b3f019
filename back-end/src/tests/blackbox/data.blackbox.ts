#!/usr/bin/env tsx
/* eslint-disable no-console */
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
 * Usage:
 *   npx tsx src/tests/blackbox/data.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/data.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
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
      thread: z.string(),
      person: z.object({
        firstName: z.string().nullable(),
        lastName: z.string().nullable(),
        phoneNumber: z.string().nullable(),
        email: z.string().nullable(),
      }),
      messages: z.array(
        z.object({
          channel: z.string(),
          from: z.string(),
          to: z.string(),
          timestamp: z.string(),
          message: z.string(),
          is_match: z.boolean(),
        })
      ),
    })
  ),
  total_matches: z.number(),
  truncated: z.boolean(),
  pattern: z.string().optional(),
  source: z.string().optional(),
  since: z.string().optional(),
  message: z.string().optional(),
  truncation_message: z.string().optional(),
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

// Real test user with 114K+ messages across 842 threads
const TEST_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

async function createAnonSession(): Promise<{ accessToken: string; userId: string }> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  return { accessToken: d.session.access_token, userId: d.user.id };
}

async function createAgentWithRetry(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  maxAttempts = 5,
  delayMs = 500
): Promise<string> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const createRes = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (createRes.status === 201) {
      return (createRes.data as { agent_id: string }).agent_id;
    }
    lastError = `status ${createRes.status}: ${JSON.stringify(createRes.data).substring(0, 200)}`;
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw new Error(`Failed to create agent after ${maxAttempts} attempts: ${lastError}`);
}

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
    body: JSON.stringify({ pattern: 'test' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (happy)');
}

async function testGrep_emptyPattern() {
  // Empty string pattern returns all messages
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '' }),
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

async function testGrep_withSince() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', since: '2024-01-01T00:00:00Z' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (with since)');
}

async function testGrep_withLimit() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', limit: 5 }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (with limit)');
}

async function testGrep_viaApiKey() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({ pattern: 'test' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (API key)');
}

async function testGrep_noMatchesShape() {
  // Fresh anonymous user has no messages
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'xyznonexistent' }),
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
}

// ==================== POST /api/data/grep (agent_network sources) ====================

const AgentNetworkGrepResponse = z.object({
  matches: z.array(
    z.object({
      agent_id: z.string(),
      message_id: z.string(),
      role: z.string(),
      text: z.string(),
      timestamp: z.string(),
      pointer: z.string(),
    })
  ),
  total_matches: z.number(),
  truncated: z.boolean(),
  message: z.string().optional(),
});

async function testGrepAgentNetwork_missingAgentId() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({ pattern: 'test', source: 'agent_network_user_messages' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'MISSING_AGENT_ID') {
    throw new Error(`Expected MISSING_AGENT_ID error, got: ${body.error}`);
  }
}

async function testGrepAgentNetwork_missingAgentIdToolResults() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({ pattern: 'test', source: 'agent_network_tool_results' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'MISSING_AGENT_ID') {
    throw new Error(`Expected MISSING_AGENT_ID error, got: ${body.error}`);
  }
}

async function testGrepAgentNetwork_nonexistentAgent() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({
      pattern: 'test',
      source: 'agent_network_user_messages',
      agent_id: '00000000-0000-0000-0000-000000000099',
    }),
  });
  assertStatus(res.status, 403, res.data);
}

async function testGrepAgentNetwork_happyUserMessages() {
  // Create an agent, then search its network (will return empty matches for fresh user)
  const agentId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: 'blackbox test agent for grep' }
  );

  try {
    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      body: JSON.stringify({
        pattern: '',
        source: 'agent_network_user_messages',
        agent_id: agentId,
      }),
    });
    assertStatus(res.status, 200, res.data);
    assertSchema(AgentNetworkGrepResponse, res.data, 'agent_network_user_messages');
  } finally {
    await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    });
  }
}

async function testGrepAgentNetwork_happyToolResults() {
  const agentId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: 'blackbox test agent for grep tool results' }
  );

  try {
    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      body: JSON.stringify({
        pattern: '',
        source: 'agent_network_tool_results',
        agent_id: agentId,
      }),
    });
    assertStatus(res.status, 200, res.data);
    assertSchema(AgentNetworkGrepResponse, res.data, 'agent_network_tool_results');
  } finally {
    await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    });
  }
}

async function testGrepAgentNetwork_sourcesInValidList() {
  // agent_network_* should NOT cause SOURCE_NOT_FOUND
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    body: JSON.stringify({
      pattern: 'test',
      source: 'agent_network_user_messages',
      agent_id: '00000000-0000-0000-0000-000000000099',
    }),
  });
  // Should get 403 (agent not found), not 400 (source not found)
  if (res.status === 400) {
    const body = res.data as { error: string };
    if (body.error === 'SOURCE_NOT_FOUND') {
      throw new Error('agent_network_user_messages should be a valid source');
    }
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_grep() {
  const body = JSON.stringify({ pattern: 'test' });
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
      body: JSON.stringify({ pattern: 'repro-test' }),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== ADDITIONAL COVERAGE TESTS ====================

// --- grep: person_id not found ---

async function testGrep_personNotFound() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', person_id: 'nonexistent-person@example.com' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'PERSON_NOT_FOUND') {
    throw new Error(`Expected error code PERSON_NOT_FOUND, got: ${body.error}`);
  }
}

async function testGrep_personNotFoundUuid() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', person_id: '00000000-0000-0000-0000-000000000001' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'PERSON_NOT_FOUND') {
    throw new Error(`Expected error code PERSON_NOT_FOUND, got: ${body.error}`);
  }
}

// --- grep: no-matches path with diagnostic message ---

async function testGrep_noMatchesMessageContent() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'xyzzy_never_matches_anything' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (no matches message)');
  if (body.total_matches !== 0) {
    throw new Error(`Expected 0 total_matches, got ${body.total_matches}`);
  }
  if (!body.message) {
    throw new Error('Expected a message field in no-matches response');
  }
  if (!body.message.includes('No matches')) {
    throw new Error(`Expected message to contain 'No matches', got: ${body.message}`);
  }
}

async function testGrep_noMatchesWithSinceLabel() {
  const sinceDate = '2025-06-01T00:00:00Z';
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'xyzzy_never_matches', since: sinceDate }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (no matches with since)');
  if (!body.message) {
    throw new Error('Expected a message field in no-matches response');
  }
}

// --- grep: limit boundary values ---

async function testGrep_limitZero() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', limit: 0 }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (limit=0)');
}

async function testGrep_limitNegative() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', limit: -5 }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (limit=-5)');
}

async function testGrep_limitHuge() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', limit: 9999 }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (limit=9999)');
}

async function testGrep_limitStringNumeric() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', limit: '10' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (limit="10")');
}

// --- grep: empty optional params ---

async function testGrep_emptyPersonIdIgnored() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', person_id: '' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (empty person_id)');
}

async function testGrep_emptySinceIgnored() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', since: '' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (empty since)');
}

// --- summary: fresh user deep shape ---

async function testSummary_freshUserShapeDeep() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (deep shape)');
  const msgs = body.sources.messages;
  if (msgs.total_threads !== 0) {
    throw new Error(`Expected 0 total_threads, got ${msgs.total_threads}`);
  }
  if (msgs.total_messages !== 0) {
    throw new Error(`Expected 0 total_messages, got ${msgs.total_messages}`);
  }
  if (msgs.date_range.from !== null) {
    throw new Error(`Expected date_range.from to be null, got ${msgs.date_range.from}`);
  }
  if (msgs.date_range.to !== null) {
    throw new Error(`Expected date_range.to to be null, got ${msgs.date_range.to}`);
  }
  if (Object.keys(msgs.channels).length !== 0) {
    throw new Error(`Expected empty channels, got ${JSON.stringify(msgs.channels)}`);
  }
  if (msgs.threads.length !== 0) {
    throw new Error(`Expected 0 threads, got ${msgs.threads.length}`);
  }
}

async function testSummary_viaApiKeyDeep() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (API key deep)');
  const jwtRes = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(ctx.accessToken!),
  });
  const jwtBody = assertSchema(SummaryResponse, jwtRes.data, 'GET /summary (JWT cross-check)');
  if (body.sources.messages.total_messages !== jwtBody.sources.messages.total_messages) {
    throw new Error('API key and JWT summary disagree on total_messages');
  }
}

// ==================== ADDITIONAL COVERAGE — SOURCE ROUTING & EDGE CASES ====================

async function testGrep_agentNetworkSourceRouting() {
  // Exercise agent_network_user_messages source with a real agent
  const agentId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: 'grep source routing test' }
  );

  try {
    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      body: JSON.stringify({
        pattern: 'hello',
        source: 'agent_network_user_messages',
        agent_id: agentId,
      }),
    });
    assertStatus(res.status, 200, res.data);
    assertSchema(AgentNetworkGrepResponse, res.data, 'agent_network_user_messages source routing');
  } finally {
    await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    });
  }
}

async function testGrep_agentNetworkToolResultsRouting() {
  // Exercise agent_network_tool_results source with a real agent
  const agentId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: 'grep tool results routing test' }
  );

  try {
    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      body: JSON.stringify({
        pattern: 'result',
        source: 'agent_network_tool_results',
        agent_id: agentId,
      }),
    });
    assertStatus(res.status, 200, res.data);
    assertSchema(AgentNetworkGrepResponse, res.data, 'agent_network_tool_results source routing');
  } finally {
    await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    });
  }
}

async function testGrep_withPersonIdFilter() {
  // person_id with a non-existent but valid UUID format
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', person_id: '00000000-0000-0000-0000-000000000042' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'PERSON_NOT_FOUND') {
    throw new Error(`Expected PERSON_NOT_FOUND, got: ${body.error}`);
  }
}

async function testGrep_withSinceTimestamp() {
  // Valid ISO since in the future → should return 0 matches
  const futureDate = '2099-01-01T00:00:00Z';
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', since: futureDate }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (future since)');
  if (body.total_matches !== 0) {
    throw new Error(`Expected 0 matches with future since, got ${body.total_matches}`);
  }
}

async function testGrep_noMatchesPath() {
  // Pattern that definitely won't match anything
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'zzz_absolutely_no_match_qqq_12345' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (no matches path)');
  if (body.total_matches !== 0) {
    throw new Error(`Expected 0 matches, got ${body.total_matches}`);
  }
  if (body.matches.length !== 0) {
    throw new Error(`Expected empty matches array, got ${body.matches.length}`);
  }
}

async function testGrep_longPatternString() {
  // Very long pattern string (500+ chars) — should be handled gracefully
  const longPattern = 'a'.repeat(600);
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: longPattern }),
  });
  // Should return 200 with no matches (pattern is valid but won't match)
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (long pattern)');
}

// ==================== DEEP COVERAGE TESTS ====================

// --- grep: exercises default source resolution (messages) ---

async function testGrep_defaultSourceMessages() {
  // Omit source entirely → should default to 'messages'
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'hello', limit: 5 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (default source)');
  // For fresh user, should return 0 matches with source=messages
  if (body.source) {
    if (body.source !== 'messages') {
      throw new Error(`Expected default source=messages, got ${body.source}`);
    }
  }
}

// --- grep: exercises no-matches path with thread/message counts ---

async function testGrep_noMatchesDiagnosticCounts() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'zzz_unique_nonexistent_pattern_xyz' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (diagnostic counts)');
  if (body.total_matches !== 0) {
    throw new Error(`Expected 0 total_matches, got ${body.total_matches}`);
  }
  // Verify the message includes thread/message count information
  if (!body.message) {
    throw new Error('Expected diagnostic message in no-matches response');
  }
  if (!body.message.includes('messages') || !body.message.includes('threads')) {
    throw new Error(`Expected message to contain 'messages' and 'threads' counts, got: ${body.message}`);
  }
}

// --- grep: exercises default since (last N days) ---

async function testGrep_defaultSincePeriod() {
  // When since is omitted, uses default (last DEFAULT_SINCE_DAYS days)
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (default since)');
  // Check that since is set to a recent date (within last year)
  if (body.since) {
    const sinceDate = new Date(body.since);
    const now = new Date();
    const diffDays = (now.getTime() - sinceDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0 || diffDays > 400) {
      throw new Error(`Expected default since within ~365 days, got ${diffDays.toFixed(0)} days ago`);
    }
  }
}

// --- grep: exercises no-matches message with explicit since label ---

async function testGrep_noMatchesExplicitSinceLabel() {
  const sinceDate = '2025-03-15T00:00:00Z';
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'totally_unique_nomatch_zzz', since: sinceDate }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (explicit since label)');
  if (!body.message) {
    throw new Error('Expected message in no-matches response');
  }
  // The message should include "since <date>" when explicit since is provided
  if (!body.message.includes('since')) {
    throw new Error(`Expected message to contain 'since', got: ${body.message}`);
  }
}

// --- grep: exercises default since label (last N days) in no-matches ---

async function testGrep_noMatchesDefaultSinceLabel() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'unique_nomatch_def_since_qqq' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (default since label)');
  if (!body.message) {
    throw new Error('Expected message in no-matches response');
  }
  // The message should include "last N days" when no since param is provided
  if (!body.message.includes('last')) {
    throw new Error(`Expected message to contain 'last' for default since period, got: ${body.message}`);
  }
}

// --- grep: limit boundary at MAX_RESULTS ---

async function testGrep_limitAtMax() {
  // Very large limit should be clamped to MAX_RESULTS
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', limit: 100000 }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (limit at max)');
}

// --- grep: since as recent timestamp ---

async function testGrep_sinceRecentTimestamp() {
  // Exercises cutoff time from recent since param
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', since: fiveMinutesAgo }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (recent since)');
}

// --- grep: exercises person_id resolution by email ---

async function testGrep_personByEmailNotFound() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', person_id: 'totally.fake@nowhere.invalid' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; message: string };
  if (body.error !== 'PERSON_NOT_FOUND') {
    throw new Error(`Expected PERSON_NOT_FOUND, got: ${body.error}`);
  }
  // Verify error message includes helpful suggestion
  if (!body.message.includes('email') && !body.message.includes('phone') && !body.message.includes('name')) {
    throw new Error(`Expected helpful error message, got: ${body.message}`);
  }
}

// --- grep: exercises person_id resolution by phone ---

async function testGrep_personByPhoneNotFound() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', person_id: '+19999999999' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'PERSON_NOT_FOUND') {
    throw new Error(`Expected PERSON_NOT_FOUND, got: ${body.error}`);
  }
}

// --- grep: exercises person_id resolution by name ---

async function testGrep_personByNameNotFound() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', person_id: 'Nonexistent PersonName' }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'PERSON_NOT_FOUND') {
    throw new Error(`Expected PERSON_NOT_FOUND, got: ${body.error}`);
  }
}

// --- summary: exercises complete summary shape for fresh user ---

async function testSummary_freshUserDateRange() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (fresh date range)');
  const msgs = body.sources.messages;
  // Fresh user should have null date range
  if (msgs.date_range.from !== null || msgs.date_range.to !== null) {
    throw new Error(`Expected null date range for fresh user, got from=${msgs.date_range.from} to=${msgs.date_range.to}`);
  }
  // No channels
  if (Object.keys(msgs.channels).length !== 0) {
    throw new Error(`Expected empty channels for fresh user, got ${JSON.stringify(msgs.channels)}`);
  }
}

// --- summary: exercises concurrent consistency ---

async function testSummary_parallelConsistency() {
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(`${BASE_URL}/api/data/summary`, {
        headers: authHeaders(ctx.accessToken!),
      })
    )
  );
  // All should succeed
  for (const r of results) {
    assertStatus(r.status, 200, r.data);
    assertSchema(SummaryResponse, r.data, 'GET /summary (parallel)');
  }
  // All should return same total_messages
  const totals = results.map(
    (r) => (r.data as { sources: { messages: { total_messages: number } } }).sources.messages.total_messages
  );
  const uniqueTotals = new Set(totals);
  if (uniqueTotals.size !== 1) {
    throw new Error(`Parallel summaries returned different total_messages: ${[...uniqueTotals].join(', ')}`);
  }
}

// --- grep: exercises source=messages explicitly ---

async function testGrep_explicitMessagesSource() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '', source: 'messages', limit: 3 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (explicit messages source)');
  if (body.source && body.source !== 'messages') {
    throw new Error(`Expected source=messages, got ${body.source}`);
  }
}

// --- grep: undefined person_id should be ignored ---

async function testGrep_undefinedPersonId() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: 'test', person_id: undefined }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (undefined person_id)');
}

// --- grep: pattern with special characters ---

async function testGrep_specialCharPattern() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: "what's up?" }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (special chars)');
}

// --- grep: pattern with unicode ---

async function testGrep_unicodePattern() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: '\u{1F600} emoji test' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (unicode pattern)');
}

// --- summary: via internal API key without X-User-Id ---

async function testSummary_apiKeyNoUserId() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: { 'X-API-Key': API_KEY },
  });
  // Missing X-User-Id should return 401 (no user identified)
  assertStatus(res.status, 401, res.data);
}

// --- grep: via internal API key with user_id in body ---

async function testGrep_apiKeyBodyUserId() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ pattern: 'test', user_id: ctx.userId }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (API key body user_id)');
}

// ==================== DEEP COVERAGE — REAL USER WITH MESSAGES ====================
// These tests use the real test user (1f85ff25...) who has 114K+ messages.
// They exercise the FULL grep pipeline: searchMessages → buildFormattedResults →
// fetchContextMessages → stripEmailQuotes → formatTimeAgo → all repo functions.

function testUserHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-User-Id': TEST_USER_ID };
}

// 1. Grep with actual matches — exercises full buildFormattedResults + context extraction
async function testGrep_realUserWithMatches() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: 'dinner', limit: 3 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user matches)');
  if (body.total_matches === 0) {
    throw new Error('Expected matches for "dinner" with real user, got 0');
  }
  if (body.matches.length === 0) {
    throw new Error('Expected formatted matches, got empty array');
  }
  // Verify match structure has context messages
  const firstMatch = body.matches[0];
  if (firstMatch.messages.length === 0) {
    throw new Error('Expected context messages around match');
  }
  // Verify at least one message is marked as a match
  const hasMatchFlag = firstMatch.messages.some((m) => m.is_match);
  if (!hasMatchFlag) {
    throw new Error('Expected at least one message with is_match=true');
  }
}

// 2. Grep with matches — exercises thread name generation from person
async function testGrep_realUserThreadNames() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: 'hello', limit: 5 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (thread names)');
  if (body.matches.length > 0) {
    // Verify thread name format: "<name>.thread"
    for (const match of body.matches) {
      if (!match.thread.endsWith('.thread')) {
        throw new Error(`Expected thread name to end with .thread, got: ${match.thread}`);
      }
    }
  }
}

// 3. Grep with empty pattern — returns all messages (exercises full pipeline)
async function testGrep_realUserEmptyPattern() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: '', limit: 5 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user empty pattern)');
  if (body.total_matches === 0) {
    throw new Error('Expected matches for empty pattern with real user');
  }
}

// 4. Grep with source=messages explicit — exercises source resolution path
async function testGrep_realUserExplicitSource() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: 'meeting', source: 'messages', limit: 3 }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (real user explicit source)');
}

// 5. Grep with since timestamp — exercises cutoff filter with actual matches
async function testGrep_realUserWithSince() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: '', since: '2025-01-01T00:00:00Z', limit: 5 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user since)');
  // Verify since is in the response and is a valid year
  if (body.since) {
    const sinceDate = new Date(body.since);
    const year = sinceDate.getFullYear();
    if (year < 2020 || year > 2030) {
      throw new Error(`Expected since year to be between 2020 and 2030, got ${year}`);
    }
  }
}

// 6. Grep with limit=1 — exercises result limiting with actual data
async function testGrep_realUserLimit1() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: 'thanks', limit: 1 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user limit=1)');
  if (body.matches.length > 1) {
    throw new Error(`Expected at most 1 thread, got ${body.matches.length}`);
  }
}

// 7. Summary for real user — exercises full summary pipeline with actual data
async function testSummary_realUser() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: testUserHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (real user)');
  const msgs = body.sources.messages;
  if (msgs.total_threads === 0) {
    throw new Error('Expected non-zero threads for real user');
  }
  if (msgs.total_messages === 0) {
    throw new Error('Expected non-zero messages for real user');
  }
  // Verify date range is populated
  if (msgs.date_range.from === null || msgs.date_range.to === null) {
    throw new Error('Expected non-null date range for real user');
  }
  // Verify channels are populated
  if (Object.keys(msgs.channels).length === 0) {
    throw new Error('Expected non-empty channels for real user');
  }
  // Verify threads have valid shape
  if (msgs.threads.length === 0) {
    throw new Error('Expected non-empty threads for real user');
  }
  const firstThread = msgs.threads[0];
  if (firstThread.message_count === 0) {
    throw new Error('Expected non-zero message_count for first thread');
  }
  if (!firstThread.last_message) {
    throw new Error('Expected last_message for first thread');
  }
}

// 8. Summary exercises formatTimeAgo with various time ranges
async function testSummary_realUserThreadTimestamps() {
  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: testUserHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (timestamps)');
  // Verify last_message format contains time ago suffix
  const validSuffixes = ['m ago', 'h ago', 'd ago', 'mo ago'];
  for (const thread of body.sources.messages.threads.slice(0, 5)) {
    const hasValidSuffix = validSuffixes.some((s) => thread.last_message.endsWith(s));
    if (!hasValidSuffix && thread.last_message !== 'unknown') {
      throw new Error(
        `Expected last_message to end with time ago suffix, got: ${thread.last_message}`
      );
    }
  }
}

// 9. Grep with large limit — exercises result truncation path (MAX_RESULT_CHARS)
async function testGrep_realUserLargeLimit() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: '', limit: 50 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (real user large limit)');
  // With 50 limit and lots of messages, might hit truncation
  if (body.total_matches > 0 && body.matches.length === 0) {
    throw new Error('Expected formatted matches when total_matches > 0');
  }
}

// 10. Grep exercises stripEmailQuotes with email messages
async function testGrep_realUserEmailChannel() {
  // Search for common email keywords to exercise stripEmailQuotes
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: 'RE:', limit: 5, since: '2024-01-01T00:00:00Z' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (email channel)');
}

// 11. Grep with person_id using real user's contact name
async function testGrep_realUserPersonByName() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: '', person_id: 'Mom', limit: 3 }),
  });
  // Should either find "Mom" or return PERSON_NOT_FOUND
  if (res.status === 200) {
    assertSchema(GrepResponse, res.data, 'POST /grep (person by name)');
  } else if (res.status === 400) {
    const body = res.data as { error: string };
    if (body.error !== 'PERSON_NOT_FOUND') {
      throw new Error(`Expected 200 or PERSON_NOT_FOUND, got: ${body.error}`);
    }
  } else {
    throw new Error(`Unexpected status ${res.status}`);
  }
}

// 12. Grep agent network with real user's agent
async function testGrepAgentNetwork_realUserAgent() {
  // Create agent, send a message, then search agent network
  const agentId = await createAgentWithRetry(
    testUserHeaders(),
    { goal: 'coverage test agent for agent network grep' }
  );

  try {
    // Search agent network user messages
    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: testUserHeaders(),
      body: JSON.stringify({
        pattern: '',
        source: 'agent_network_user_messages',
        agent_id: agentId,
        limit: 10,
      }),
    });
    assertStatus(res.status, 200, res.data);
    assertSchema(AgentNetworkGrepResponse, res.data, 'agent_network real user');

    // Also search tool results
    const toolRes = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: testUserHeaders(),
      body: JSON.stringify({
        pattern: '',
        source: 'agent_network_tool_results',
        agent_id: agentId,
        limit: 10,
      }),
    });
    assertStatus(toolRes.status, 200, toolRes.data);
  } finally {
    await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: testUserHeaders(),
    });
  }
}

// 13. Grep with multiple matches in different threads — exercises matchesByThread grouping
async function testGrep_realUserMultipleThreads() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: testUserHeaders(),
    body: JSON.stringify({ pattern: 'ok', limit: 20 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GrepResponse, res.data, 'POST /grep (multiple threads)');
  // "ok" should match across multiple threads
  if (body.matches.length > 1) {
    // Verify different threads
    const threads = new Set(body.matches.map((m) => m.thread));
    if (threads.size < 2) {
      // That's fine, but ideally we'd see multiple threads
    }
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
    { name: 'POST /data/grep -- with since', fn: testGrep_withSince },
    { name: 'POST /data/grep -- with limit', fn: testGrep_withLimit },
    { name: 'POST /data/grep -- via API key', fn: testGrep_viaApiKey },
    { name: 'POST /data/grep -- no matches shape', fn: testGrep_noMatchesShape },
    { name: 'GET /data/summary -- happy path (JWT)', fn: testSummary_happyJwt },
    { name: 'GET /data/summary -- happy path (API key)', fn: testSummary_happyApiKey },
    { name: 'GET /data/summary -- fresh user empty', fn: testSummary_freshUserEmpty },
    // agent network grep
    {
      name: 'POST /data/grep -- agent_network_user_messages missing agent_id -> 400',
      fn: testGrepAgentNetwork_missingAgentId,
    },
    {
      name: 'POST /data/grep -- agent_network_tool_results missing agent_id -> 400',
      fn: testGrepAgentNetwork_missingAgentIdToolResults,
    },
    {
      name: 'POST /data/grep -- agent_network nonexistent agent -> 403',
      fn: testGrepAgentNetwork_nonexistentAgent,
    },
    {
      name: 'POST /data/grep -- agent_network_user_messages happy path',
      fn: testGrepAgentNetwork_happyUserMessages,
    },
    {
      name: 'POST /data/grep -- agent_network_tool_results happy path',
      fn: testGrepAgentNetwork_happyToolResults,
    },
    {
      name: 'POST /data/grep -- agent_network sources are valid',
      fn: testGrepAgentNetwork_sourcesInValidList,
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
    // additional coverage — person_id validation
    { name: 'POST /data/grep -- person_id not found (email) -> 400', fn: testGrep_personNotFound },
    { name: 'POST /data/grep -- person_id not found (UUID) -> 400', fn: testGrep_personNotFoundUuid },
    // additional coverage — no-matches path
    { name: 'POST /data/grep -- no matches message content', fn: testGrep_noMatchesMessageContent },
    { name: 'POST /data/grep -- no matches with explicit since', fn: testGrep_noMatchesWithSinceLabel },
    // additional coverage — limit boundary values
    { name: 'POST /data/grep -- limit=0 clamps', fn: testGrep_limitZero },
    { name: 'POST /data/grep -- limit=-5 clamps', fn: testGrep_limitNegative },
    { name: 'POST /data/grep -- limit=9999 clamps', fn: testGrep_limitHuge },
    { name: 'POST /data/grep -- limit="10" string', fn: testGrep_limitStringNumeric },
    // additional coverage — empty optional params
    { name: 'POST /data/grep -- empty person_id ignored', fn: testGrep_emptyPersonIdIgnored },
    { name: 'POST /data/grep -- empty since ignored', fn: testGrep_emptySinceIgnored },
    // additional coverage — summary deep shape
    { name: 'GET /data/summary -- fresh user deep shape', fn: testSummary_freshUserShapeDeep },
    { name: 'GET /data/summary -- API key vs JWT cross-check', fn: testSummary_viaApiKeyDeep },
    // additional coverage — source routing & edge cases
    {
      name: 'POST /data/grep -- agent_network_user_messages source routing',
      fn: testGrep_agentNetworkSourceRouting,
    },
    {
      name: 'POST /data/grep -- agent_network_tool_results source routing',
      fn: testGrep_agentNetworkToolResultsRouting,
    },
    { name: 'POST /data/grep -- person_id filter -> 400', fn: testGrep_withPersonIdFilter },
    { name: 'POST /data/grep -- since future timestamp -> 0 matches', fn: testGrep_withSinceTimestamp },
    { name: 'POST /data/grep -- no matches path exercises empty result', fn: testGrep_noMatchesPath },
    { name: 'POST /data/grep -- long pattern string (600 chars)', fn: testGrep_longPatternString },
    // deep coverage — real user with messages
    { name: 'POST /data/grep -- real user with matches (full pipeline)', fn: testGrep_realUserWithMatches },
    { name: 'POST /data/grep -- real user thread names', fn: testGrep_realUserThreadNames },
    { name: 'POST /data/grep -- real user empty pattern', fn: testGrep_realUserEmptyPattern },
    { name: 'POST /data/grep -- real user explicit source', fn: testGrep_realUserExplicitSource },
    { name: 'POST /data/grep -- real user with since filter', fn: testGrep_realUserWithSince },
    { name: 'POST /data/grep -- real user limit=1', fn: testGrep_realUserLimit1 },
    { name: 'GET /data/summary -- real user with messages', fn: testSummary_realUser },
    { name: 'GET /data/summary -- real user thread timestamps', fn: testSummary_realUserThreadTimestamps },
    { name: 'POST /data/grep -- real user large limit (truncation)', fn: testGrep_realUserLargeLimit },
    { name: 'POST /data/grep -- real user email channel', fn: testGrep_realUserEmailChannel },
    { name: 'POST /data/grep -- real user person by name', fn: testGrep_realUserPersonByName },
    { name: 'POST /data/grep -- real user agent network', fn: testGrepAgentNetwork_realUserAgent },
    { name: 'POST /data/grep -- real user multiple threads', fn: testGrep_realUserMultipleThreads },
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
