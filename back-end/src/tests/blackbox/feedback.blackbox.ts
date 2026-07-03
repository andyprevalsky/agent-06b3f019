#!/usr/bin/env tsx
/**
 * Black-box tests for the feedback domain
 *
 * Covers:
 *   POST /api/feedback — submit user feedback (auth required)
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401
 *   - error-surface: all error responses include { error: string }
 *   - read-after-write: not directly testable (no GET endpoint); tested via
 *     repeated POST success as a proxy — the DB insert did not fail
 *   - reproducibility: same inputs always produce same { success: true }
 *   - cleanup: each test run creates a fresh anonymous user; no shared mutable fixtures
 *   - concurrency: parallel POST submissions all succeed independently
 *
 * Invariants not applicable:
 *   - idempotency: each POST creates a new Feedback row; there is no update/upsert semantic
 *   - state-transition: no state machine — single INSERT operation
 *   - ordering/pagination: no list endpoint
 *   - atomicity: single Prisma create, no multi-step transaction
 *   - referential integrity: userId is stored as a plain string, not a foreign key
 *   - event/job cardinality: no async side effects
 *   - duplication prevention: duplicate feedback is allowed by design
 *   - tenant isolation: no read endpoint to verify cross-user visibility
 *   - time/clock: no timestamp behavior exposed in the response
 *   - boundary param: no third-party HTTP calls in this domain
 *   - call ordering: no outbound calls
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Usage:
 *   npx tsx src/tests/blackbox/feedback.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/feedback.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const SuccessResponse = z.object({ success: z.literal(true) });
const ErrorResponse = z.object({ error: z.string() });

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
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token;
  ctx.userId = d.user.id;
}

// ==================== POST /api/feedback ====================

// --- auth boundary ---

async function testFeedback_noAuth() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    body: JSON.stringify({ feedback: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback no-auth');
}

async function testFeedback_invalidToken() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders('invalid.jwt.token'),
    body: JSON.stringify({ feedback: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback invalid-token');
}

// --- happy path ---

async function testFeedback_happy() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: 'Great product!' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /feedback happy');
}

async function testFeedback_longString() {
  const longFeedback = 'A'.repeat(5000);
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: longFeedback }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /feedback long-string');
}

async function testFeedback_unicodeContent() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: 'Great app! 🚀 日本語テスト ñ é ü' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /feedback unicode');
}

async function testFeedback_trimmedWhitespace() {
  // Leading/trailing whitespace should be trimmed but still accepted
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: '  valid feedback  ' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /feedback trimmed');
}

async function testFeedback_multipleSubmissions() {
  // Same user can submit multiple feedbacks (no idempotency constraint)
  const results = await Promise.all([
    request(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: authHeaders(ctx.accessToken!),
      body: JSON.stringify({ feedback: 'First feedback' }),
    }),
    request(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: authHeaders(ctx.accessToken!),
      body: JSON.stringify({ feedback: 'Second feedback' }),
    }),
  ]);
  for (const res of results) {
    assertStatus(res.status, 200, res.data);
    assertSchema(SuccessResponse, res.data, 'POST /feedback multiple');
  }
}

// --- validation ---

async function testFeedback_missingFeedback() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback missing-feedback');
}

async function testFeedback_emptyString() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback empty-string');
}

async function testFeedback_whitespaceOnly() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: '   ' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback whitespace-only');
}

async function testFeedback_nullValue() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: null }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback null');
}

async function testFeedback_numericValue() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: 12345 }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback numeric');
}

async function testFeedback_booleanValue() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: true }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback boolean');
}

async function testFeedback_arrayValue() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: ['one', 'two'] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback array');
}

async function testFeedback_emptyBody() {
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify(null),
  });
  assertStatus(res.status, 400, res.data);
}

async function testFeedback_extraFieldsIgnored() {
  // Extra fields should not cause errors
  const res = await request(`${BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ feedback: 'valid', extra: 'ignored', rating: 5 }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /feedback extra-fields');
}

// ==================== RUN ====================

async function runAll() {
  console.log('Feedback Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  await setup();
  console.log(`  User: ${ctx.userId}\n`);

  const parallelTests = [
    // auth boundary
    { name: 'POST /feedback -- no auth -> 401', fn: testFeedback_noAuth },
    { name: 'POST /feedback -- invalid token -> 401', fn: testFeedback_invalidToken },
    // happy path
    { name: 'POST /feedback -- happy path', fn: testFeedback_happy },
    { name: 'POST /feedback -- long string (5000 chars)', fn: testFeedback_longString },
    { name: 'POST /feedback -- unicode content', fn: testFeedback_unicodeContent },
    { name: 'POST /feedback -- trimmed whitespace accepted', fn: testFeedback_trimmedWhitespace },
    { name: 'POST /feedback -- multiple submissions', fn: testFeedback_multipleSubmissions },
    { name: 'POST /feedback -- extra fields ignored', fn: testFeedback_extraFieldsIgnored },
    // validation
    { name: 'POST /feedback -- missing feedback -> 400', fn: testFeedback_missingFeedback },
    { name: 'POST /feedback -- empty string -> 400', fn: testFeedback_emptyString },
    { name: 'POST /feedback -- whitespace only -> 400', fn: testFeedback_whitespaceOnly },
    { name: 'POST /feedback -- null value -> 400', fn: testFeedback_nullValue },
    { name: 'POST /feedback -- numeric value -> 400', fn: testFeedback_numericValue },
    { name: 'POST /feedback -- boolean value -> 400', fn: testFeedback_booleanValue },
    { name: 'POST /feedback -- array value -> 400', fn: testFeedback_arrayValue },
    { name: 'POST /feedback -- empty body -> 400', fn: testFeedback_emptyBody },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const results = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  // ==================== SUMMARY ====================

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log('\nALL FEEDBACK BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
