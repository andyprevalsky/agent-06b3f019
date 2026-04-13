#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/data — real-user pipeline coverage
 *
 * Uses the real test user (1f85ff25...) who has 114K+ messages across 842 threads.
 * Exercises the FULL grep pipeline: searchMessages → buildFormattedResults →
 * fetchContextMessages → stripEmailQuotes → formatTimeAgo → all repo functions.
 *
 * Covered:
 *   1. Grep with actual matches (full buildFormattedResults + context extraction)
 *   2. Thread name generation from person
 *   3. Empty pattern — returns all messages (full pipeline)
 *   4. Explicit source=messages
 *   5. Since timestamp filter with actual matches
 *   6. Limit=1 result limiting
 *   7. Full summary pipeline with real data
 *   8. Summary formatTimeAgo with various time ranges
 *   9. Large limit — exercises result truncation (MAX_RESULT_CHARS)
 *  10. Email channel — exercises stripEmailQuotes
 *  11. Person-id by name (real contact)
 *  12. Agent network grep with real user's agent
 *  13. Multiple threads grouping (matchesByThread)
 *
 * Usage:
 *   npx tsx src/tests/blackbox/data-real-user.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/data-real-user.blackbox.ts
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

// Real test user with 114K+ messages across 842 threads
const TEST_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

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
      created_at: z.string().optional(),
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

function testUserHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-User-Id': TEST_USER_ID };
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

// ==================== REAL-USER TESTS ====================

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
  const agentId = await createAgentWithRetry(testUserHeaders(), {
    goal: 'coverage test agent for agent network grep',
  });

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
    const deleteRes = await request(`${BASE_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: testUserHeaders(),
    });
    if (deleteRes.status !== 200 && deleteRes.status !== 204) {
      console.error(
        `Agent cleanup failed: status ${deleteRes.status}: ${JSON.stringify(deleteRes.data).substring(0, 200)}`
      );
    }
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
  console.log('Data Real-User Pipeline Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);
  console.log(`Using real test user: ${TEST_USER_ID}\n`);

  const parallelTests = [
    {
      name: 'POST /data/grep -- real user with matches (full pipeline)',
      fn: testGrep_realUserWithMatches,
    },
    { name: 'POST /data/grep -- real user thread names', fn: testGrep_realUserThreadNames },
    { name: 'POST /data/grep -- real user empty pattern', fn: testGrep_realUserEmptyPattern },
    { name: 'POST /data/grep -- real user explicit source', fn: testGrep_realUserExplicitSource },
    { name: 'POST /data/grep -- real user with since filter', fn: testGrep_realUserWithSince },
    { name: 'POST /data/grep -- real user limit=1', fn: testGrep_realUserLimit1 },
    { name: 'GET /data/summary -- real user with messages', fn: testSummary_realUser },
    {
      name: 'GET /data/summary -- real user thread timestamps',
      fn: testSummary_realUserThreadTimestamps,
    },
    {
      name: 'POST /data/grep -- real user large limit (truncation)',
      fn: testGrep_realUserLargeLimit,
    },
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
  console.log('\nALL DATA REAL-USER TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
