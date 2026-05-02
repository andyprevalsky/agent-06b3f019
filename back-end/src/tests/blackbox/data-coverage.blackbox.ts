#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for /api/data — additional coverage: person_id, limits, source routing
 *
 * Covered: person_id not found (email/UUID), no-matches diagnostics, limit boundaries (0/-/huge/string),
 * empty optional params, summary deep shape, API-key vs JWT cross-check, agent network source routing
 * (user_messages + tool_results), future since → 0 matches, no-matches path, long pattern string.
 *
 * See also: data.blackbox.ts, data-grep.blackbox.ts, data-real-user.blackbox.ts
 *
 * Usage:
 *   npx tsx src/tests/blackbox/data-coverage.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
import { retryWithBackoff } from '../../providers/retry';
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

async function setup(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  if (res.status !== 200) {
    throw new Error(
      `Setup failed: expected status 200, got ${res.status}: ${JSON.stringify(res.data).substring(0, 300)}`
    );
  }
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token;
  ctx.userId = d.user.id;
}

async function createAgentWithRetry(
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<string> {
  return retryWithBackoff(
    async () => {
      const createRes = await request(`${BASE_URL}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (createRes.status !== 201) {
        const err = new Error(
          `Agent create failed: status ${createRes.status}: ${JSON.stringify(createRes.data).substring(0, 200)}`
        );
        Object.assign(err, { retryable: true });
        throw err;
      }
      return (createRes.data as { agent_id: string }).agent_id;
    },
    { maxRetries: 5, initialBackoffMs: 500, component: 'createAgentWithRetry' }
  );
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

// --- grep: pattern as boolean / array / object — invalid types ---

async function testGrep_booleanPattern() {
  // pattern type validation should reject booleans
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: true }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'INVALID_PATTERN') {
    throw new Error(`Expected INVALID_PATTERN, got: ${body.error}`);
  }
}

async function testGrep_arrayPattern() {
  // pattern type validation should reject arrays
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: ['hello'] }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'INVALID_PATTERN') {
    throw new Error(`Expected INVALID_PATTERN, got: ${body.error}`);
  }
}

async function testGrep_objectPattern() {
  // pattern type validation should reject objects
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ pattern: { foo: 'bar' } }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  if (body.error !== 'INVALID_PATTERN') {
    throw new Error(`Expected INVALID_PATTERN, got: ${body.error}`);
  }
}

// --- grep: agent_network with multi-level parent chain ---
// Exercises repo.findRootAgentId multi-iteration loop (line 307 — while continues
// past the first iteration, walking up from grandchild through child to root).

async function testGrep_agentNetworkMultiLevelTree() {
  // Build a chain: root → child → grandchild
  const rootId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: 'multi-level tree root' }
  );

  try {
    const childId = await createAgentWithRetry(
      { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      { goal: 'multi-level tree child', parent_agent_id: rootId }
    );

    const grandchildId = await createAgentWithRetry(
      { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      { goal: 'multi-level tree grandchild', parent_agent_id: childId }
    );

    try {
      // Search starting from grandchild — repo.findRootAgentId walks up 2 levels
      const res = await request(`${BASE_URL}/api/data/grep`, {
        method: 'POST',
        headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
        body: JSON.stringify({
          pattern: '',
          source: 'agent_network_user_messages',
          agent_id: grandchildId,
        }),
      });
      assertStatus(res.status, 200, res.data);
      assertSchema(AgentNetworkGrepResponse, res.data, 'agent_network multi-level tree');
    } finally {
      await request(`${BASE_URL}/api/agents/${grandchildId}`, {
        method: 'DELETE',
        headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      });
      await request(`${BASE_URL}/api/agents/${childId}`, {
        method: 'DELETE',
        headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      });
    }
  } finally {
    await request(`${BASE_URL}/api/agents/${rootId}`, {
      method: 'DELETE',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    });
  }
}

// Exercises agentNetworkService.ts line 98 — long-text truncation
// (msg.text > MAX_AGENT_NETWORK_TEXT (500) chars → substring + '...').
async function testGrep_agentNetworkLongTextTruncation() {
  // Use a goal > 500 chars; goal becomes a USER message, returned by grep
  const longGoal = 'Long goal: ' + 'x'.repeat(600) + ' END';
  const agentId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: longGoal }
  );

  try {
    const res = await request(`${BASE_URL}/api/data/grep`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      body: JSON.stringify({
        pattern: 'Long goal',
        source: 'agent_network_user_messages',
        agent_id: agentId,
      }),
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(AgentNetworkGrepResponse, res.data, 'agent_network long-text');
    if (body.matches.length === 0) {
      throw new Error('Expected to find the long-goal user message');
    }
    // Verify text was truncated (ends with '...' and length close to 500)
    const match = body.matches.find((m) => m.text.includes('Long goal'));
    if (!match) {
      throw new Error('Expected to find match containing the long goal text');
    }
    if (!match.text.endsWith('...')) {
      throw new Error(`Expected truncated text to end with '...', got: ${match.text.slice(-20)}`);
    }
    if (match.text.length > 510) {
      throw new Error(`Expected truncated text length <= 503, got ${match.text.length}`);
    }
  } finally {
    await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    });
  }
}

async function testGrep_agentNetworkStartFromMidTree() {
  // Search starting from a child (not the root) — exercises walking up to find root
  // before BFS-ing back down to find siblings.
  const rootId = await createAgentWithRetry(
    { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    { goal: 'mid-tree root' }
  );

  try {
    const childA = await createAgentWithRetry(
      { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      { goal: 'mid-tree child A', parent_agent_id: rootId }
    );
    const childB = await createAgentWithRetry(
      { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      { goal: 'mid-tree child B', parent_agent_id: rootId }
    );

    try {
      // Search starting from childA — should walk up to root, then BFS to find childB
      const res = await request(`${BASE_URL}/api/data/grep`, {
        method: 'POST',
        headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
        body: JSON.stringify({
          pattern: '',
          source: 'agent_network_tool_results',
          agent_id: childA,
        }),
      });
      assertStatus(res.status, 200, res.data);
      assertSchema(AgentNetworkGrepResponse, res.data, 'agent_network mid-tree start');
    } finally {
      await request(`${BASE_URL}/api/agents/${childA}`, {
        method: 'DELETE',
        headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      });
      await request(`${BASE_URL}/api/agents/${childB}`, {
        method: 'DELETE',
        headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
      });
    }
  } finally {
    await request(`${BASE_URL}/api/agents/${rootId}`, {
      method: 'DELETE',
      headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! },
    });
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Data Additional-Coverage Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  await setup();
  console.log(`  User: ${ctx.userId}\n`);

  const parallelTests = [
    // additional coverage — person_id validation
    { name: 'POST /data/grep -- person_id not found (email) -> 400', fn: testGrep_personNotFound },
    {
      name: 'POST /data/grep -- person_id not found (UUID) -> 400',
      fn: testGrep_personNotFoundUuid,
    },
    // additional coverage — no-matches path
    { name: 'POST /data/grep -- no matches message content', fn: testGrep_noMatchesMessageContent },
    {
      name: 'POST /data/grep -- no matches with explicit since',
      fn: testGrep_noMatchesWithSinceLabel,
    },
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
    {
      name: 'POST /data/grep -- since future timestamp -> 0 matches',
      fn: testGrep_withSinceTimestamp,
    },
    {
      name: 'POST /data/grep -- no matches path exercises empty result',
      fn: testGrep_noMatchesPath,
    },
    { name: 'POST /data/grep -- long pattern string (600 chars)', fn: testGrep_longPatternString },
    // additional coverage — invalid pattern types
    { name: 'POST /data/grep -- boolean pattern -> 400', fn: testGrep_booleanPattern },
    { name: 'POST /data/grep -- array pattern -> 400', fn: testGrep_arrayPattern },
    { name: 'POST /data/grep -- object pattern -> 400', fn: testGrep_objectPattern },
    // additional coverage — agent network tree walking (multi-level parent chain)
    {
      name: 'POST /data/grep -- agent_network 3-level tree walks parent chain',
      fn: testGrep_agentNetworkMultiLevelTree,
    },
    {
      name: 'POST /data/grep -- agent_network from mid-tree finds siblings',
      fn: testGrep_agentNetworkStartFromMidTree,
    },
    {
      name: 'POST /data/grep -- agent_network long text gets truncated to 500 chars',
      fn: testGrep_agentNetworkLongTextTruncation,
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
  console.log('\nALL DATA ADDITIONAL-COVERAGE TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
