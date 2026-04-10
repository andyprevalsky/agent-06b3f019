#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/data — deep grep coverage
 *
 * Covers: default source resolution, no-matches diagnostics, limit/since boundaries,
 * person_id resolution (email/phone/name), explicit source routing, unicode patterns,
 * API-key + body user_id, parallel summary consistency, fresh-user date-range shape.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/data-grep.blackbox.ts
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
    throw new Error(
      `Expected message to contain 'messages' and 'threads' counts, got: ${body.message}`
    );
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
      throw new Error(
        `Expected default since within ~365 days, got ${diffDays.toFixed(0)} days ago`
      );
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
    throw new Error(
      `Expected message to contain 'last' for default since period, got: ${body.message}`
    );
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
  if (
    !body.message.includes('email') &&
    !body.message.includes('phone') &&
    !body.message.includes('name')
  ) {
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
  const anonRes = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  if (anonRes.status !== 200) {
    throw new Error(`Anonymous auth failed: ${anonRes.status}`);
  }
  const anonData = anonRes.data as { session: { access_token: string }; user: { id: string } };
  const accessToken = anonData.session.access_token;

  const res = await request(`${BASE_URL}/api/data/summary`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SummaryResponse, res.data, 'GET /summary (fresh date range)');
  const msgs = body.sources.messages;
  // Fresh user should have null date range
  if (msgs.date_range.from !== null || msgs.date_range.to !== null) {
    throw new Error(
      `Expected null date range for fresh user, got from=${msgs.date_range.from} to=${msgs.date_range.to}`
    );
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
    (r) =>
      (r.data as { sources: { messages: { total_messages: number } } }).sources.messages
        .total_messages
  );
  const uniqueTotals = new Set(totals);
  if (uniqueTotals.size !== 1) {
    throw new Error(
      `Parallel summaries returned different total_messages: ${[...uniqueTotals].join(', ')}`
    );
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
    headers: apiKeyHeaders(),
  });
  // Missing X-User-Id should return 401 (no user identified)
  assertStatus(res.status, 401, res.data);
}

// --- grep: via internal API key with user_id in body ---

async function testGrep_apiKeyBodyUserId() {
  const res = await request(`${BASE_URL}/api/data/grep`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ pattern: 'test', user_id: ctx.userId }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (API key body user_id)');
}

// ==================== RUN ====================

async function runAll() {
  console.log('Data Grep Deep-Coverage Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  await setup();
  console.log(`  User: ${ctx.userId}\n`);

  const parallelTests = [
    // deep coverage — default source / since / limits
    {
      name: 'POST /data/grep -- default source resolves to messages',
      fn: testGrep_defaultSourceMessages,
    },
    {
      name: 'POST /data/grep -- no-matches diagnostic includes thread/msg counts',
      fn: testGrep_noMatchesDiagnosticCounts,
    },
    {
      name: 'POST /data/grep -- default since period within ~365 days',
      fn: testGrep_defaultSincePeriod,
    },
    {
      name: "POST /data/grep -- no-matches explicit since includes 'since'",
      fn: testGrep_noMatchesExplicitSinceLabel,
    },
    {
      name: "POST /data/grep -- no-matches default since includes 'last'",
      fn: testGrep_noMatchesDefaultSinceLabel,
    },
    { name: 'POST /data/grep -- limit=100000 clamped to MAX_RESULTS', fn: testGrep_limitAtMax },
    { name: 'POST /data/grep -- since=5min ago returns valid shape', fn: testGrep_sinceRecentTimestamp },
    // deep coverage — person_id resolution paths
    { name: 'POST /data/grep -- person_id by email not found -> 400', fn: testGrep_personByEmailNotFound },
    { name: 'POST /data/grep -- person_id by phone not found -> 400', fn: testGrep_personByPhoneNotFound },
    { name: 'POST /data/grep -- person_id by name not found -> 400', fn: testGrep_personByNameNotFound },
    // deep coverage — summary
    { name: 'GET /data/summary -- fresh user has null date range', fn: testSummary_freshUserDateRange },
    { name: 'GET /data/summary -- 5 parallel requests consistent total_messages', fn: testSummary_parallelConsistency },
    // deep coverage — source routing & input edge cases
    { name: "POST /data/grep -- source='messages' explicit echoed in response", fn: testGrep_explicitMessagesSource },
    { name: 'POST /data/grep -- undefined person_id ignored', fn: testGrep_undefinedPersonId },
    { name: "POST /data/grep -- special-char pattern (what's up?)", fn: testGrep_specialCharPattern },
    { name: 'POST /data/grep -- unicode emoji pattern', fn: testGrep_unicodePattern },
    // deep coverage — API key combinations
    { name: 'GET /data/summary -- API key without X-User-Id -> 401', fn: testSummary_apiKeyNoUserId },
    { name: 'POST /data/grep -- API key with user_id in body -> 200', fn: testGrep_apiKeyBodyUserId },
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
  console.log('\nALL DATA GREP DEEP-COVERAGE TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
