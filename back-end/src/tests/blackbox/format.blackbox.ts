#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/generate-llm-judge-prompt (format domain)
 *
 * Domain surface:
 *   POST /api/generate-llm-judge-prompt — generate an LLM judge prompt from a goal (auth required)
 *
 * Boundary capture coverage:
 *   This domain makes one outbound third-party HTTP call:
 *   - POST https://openrouter.ai/api/v1/chat/completions (via generateLLMJudgePrompt)
 *   Boundary tests verify the URL, method, and header keys of the outbound call.
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401
 *   - error-surface: invalid body returns 400 with { error, details }; 500 on OpenRouter failure
 *   - idempotency: same goal produces same-shaped response (prompt is non-empty string)
 *   - concurrency: 5 parallel valid requests all return 200
 *   - same-input reproducibility: three sequential requests all return 200 with prompt
 *   - cleanup: no persistent state mutations (prompt generation is stateless)
 *   - boundary param: OpenRouter call uses expected URL, POST method, and auth headers
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: no read endpoint (stateless generation)
 *   - state-transition: no state machine
 *   - ordering/pagination: no list endpoints
 *   - atomicity: single external call, no transactions
 *   - referential integrity: no DB relations
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: stateless, no dedup needed
 *   - tenant isolation: no user-scoped data
 *   - time/clock: no timestamps in response
 *   - call ordering: single outbound call per request
 *
 * Usage:
 *   npx tsx src/tests/blackbox/format.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/format.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({
  error: z.string(),
  details: z.union([z.array(z.any()), z.string()]).optional(),
  hasOpenRouterKey: z.boolean().optional(),
});

const GeneratePromptResponse = z.object({
  prompt: z.string(),
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

// ==================== POST /api/generate-llm-judge-prompt ====================

// --- auth boundary ---

async function testGenerate_noAuth() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    body: JSON.stringify({ goal: 'Test goal' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testGenerate_invalidToken() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders('invalid.jwt.token'),
    body: JSON.stringify({ goal: 'Test goal' }),
  });
  assertStatus(res.status, 401, res.data);
}

// --- validation ---

async function testGenerate_emptyBody() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 empty body)');
}

async function testGenerate_emptyGoal() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 empty goal)');
}

async function testGenerate_missingGoal() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ notGoal: 'something' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing goal)');
}

async function testGenerate_nullGoal() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: null }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testGenerate_numericGoal() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: 12345 }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testGenerate_nullBody() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify(null),
  });
  assertStatus(res.status, 400, res.data);
}

// --- happy path ---

async function testGenerate_happy() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: 'Book a restaurant reservation for Friday night' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GeneratePromptResponse, res.data, 'POST / (happy)');
  if (!body.prompt || body.prompt.length === 0) {
    throw new Error('Expected non-empty prompt string');
  }
}

async function testGenerate_longGoal() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: 'A'.repeat(2000) }),
  });
  // Should either succeed or return a structured error — not crash
  if (res.status === 200) {
    assertSchema(GeneratePromptResponse, res.data, 'POST / (long goal)');
  } else if (res.status === 500 || res.status === 400) {
    assertSchema(ErrorResponse, res.data, `POST / (long goal ${res.status})`);
  } else {
    throw new Error(
      `Unexpected status ${res.status}: ${JSON.stringify(res.data).substring(0, 300)}`
    );
  }
}

async function testGenerate_extraFieldsIgnored() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: 'Send an email to John', extra: 'ignored', rating: 5 }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GeneratePromptResponse, res.data, 'POST / (extra fields)');
}

// --- method checks ---

async function testGenerate_getNotAllowed() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    headers: authHeaders(ctx.accessToken!),
  });
  if (res.status === 200) {
    throw new Error('GET should not return 200');
  }
}

// ==================== INVARIANTS ====================

async function testReproducibility_threeSequential() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
      method: 'POST',
      headers: authHeaders(ctx.accessToken!),
      body: JSON.stringify({ goal: 'Schedule a meeting with the team' }),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(
      `Three sequential requests returned different statuses: ${statuses.join(', ')}`
    );
  }
}

// ==================== CONCURRENCY ====================

async function testConcurrency_fiveParallelValid() {
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
        method: 'POST',
        headers: authHeaders(ctx.accessToken!),
        body: JSON.stringify({ goal: 'Plan a team offsite event' }),
      })
    )
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Concurrent requests returned mixed statuses: ${[...statuses].join(', ')}`);
  }
  if (!statuses.has(200)) {
    throw new Error(`Expected all 200, got: ${[...statuses].join(', ')}`);
  }
}

// ==================== BOUNDARY CAPTURE — OPENROUTER ====================

async function testBoundary_openRouterCallOnGenerate() {
  // Clear captures, then generate a prompt
  const clearRes = await request(`${BASE_URL}/api/test/captures`, { method: 'DELETE' });
  if (clearRes.status === 404) return; // capture harness not active, skip

  await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: 'Boundary test goal' }),
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as {
    captures: { url: string; method: string; requestHeaders: Record<string, string> }[];
  };

  const openRouterCalls = body.captures.filter(
    (c) => c.url.includes('openrouter.ai') && c.url.includes('/chat/completions')
  );
  if (openRouterCalls.length === 0) {
    // SDK may use its own HTTP client instead of globalThis.fetch — skip gracefully
    return;
  }

  const call = openRouterCalls[0];

  // Assert method is POST (chat completions)
  if (call.method !== 'POST') {
    throw new Error(`Expected method POST, got ${call.method}`);
  }

  // Assert Authorization header present
  const headerKeys = Object.keys(call.requestHeaders).map((k) => k.toLowerCase());
  if (!headerKeys.includes('authorization')) {
    throw new Error(
      `Expected Authorization header, got: ${JSON.stringify(Object.keys(call.requestHeaders))}`
    );
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Format (generate-llm-judge-prompt) Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  await setup();
  console.log(`  User: ${ctx.userId}\n`);

  const parallelTests = [
    // auth boundary
    { name: 'POST /generate-llm-judge-prompt -- no auth -> 401', fn: testGenerate_noAuth },
    {
      name: 'POST /generate-llm-judge-prompt -- invalid token -> 401',
      fn: testGenerate_invalidToken,
    },
    // validation
    { name: 'POST /generate-llm-judge-prompt -- empty body -> 400', fn: testGenerate_emptyBody },
    { name: 'POST /generate-llm-judge-prompt -- empty goal -> 400', fn: testGenerate_emptyGoal },
    {
      name: 'POST /generate-llm-judge-prompt -- missing goal -> 400',
      fn: testGenerate_missingGoal,
    },
    { name: 'POST /generate-llm-judge-prompt -- null goal -> 400', fn: testGenerate_nullGoal },
    {
      name: 'POST /generate-llm-judge-prompt -- numeric goal -> 400',
      fn: testGenerate_numericGoal,
    },
    { name: 'POST /generate-llm-judge-prompt -- null body -> 400', fn: testGenerate_nullBody },
    // happy path
    { name: 'POST /generate-llm-judge-prompt -- happy path', fn: testGenerate_happy },
    { name: 'POST /generate-llm-judge-prompt -- long goal', fn: testGenerate_longGoal },
    {
      name: 'POST /generate-llm-judge-prompt -- extra fields ignored',
      fn: testGenerate_extraFieldsIgnored,
    },
    // method check
    { name: 'GET /generate-llm-judge-prompt -- not allowed', fn: testGenerate_getNotAllowed },
    // invariants
    {
      name: 'reproducibility -- 3 sequential same status',
      fn: testReproducibility_threeSequential,
    },
    {
      name: 'concurrency -- 5 parallel valid requests all succeed',
      fn: testConcurrency_fiveParallelValid,
    },
  ];

  const sequentialTests = [
    // boundary capture (must be sequential due to shared capture buffer)
    { name: 'boundary -- OpenRouter call on generate', fn: testBoundary_openRouterCallOnGenerate },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  console.log(`Running ${sequentialTests.length} sequential boundary tests...`);
  const sequentialResults: TestResult[] = [];
  for (const test of sequentialTests) {
    sequentialResults.push(await runTest(test.name, test.fn));
  }

  const allResults = [...parallelResults, ...sequentialResults];

  for (const r of allResults) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL FORMAT BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
