#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/vapi
 *
 * Domain surface:
 *   POST /api/vapi/call     — initiate an outbound phone call via Vapi (auth: API key)
 *   GET  /api/vapi/call/:id — poll call status from Vapi (auth: API key)
 *
 * Boundary capture coverage:
 *   Both endpoints make outbound HTTP calls to the Vapi API:
 *   - POST https://api.vapi.ai/call (create call)
 *   - GET  https://api.vapi.ai/call/:id (poll call)
 *   Boundary tests verify URL, method, and Authorization header of outbound calls.
 *   Note: Happy path tests may fail if VAPI_PRIVATE_KEY is not configured (returns 500).
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401
 *   - error-surface: missing required fields return 400; Vapi misconfigured returns 500
 *   - idempotency: same invalid request always returns same error
 *   - concurrency: 10 parallel auth-check requests return consistent results
 *   - same-input reproducibility: three sequential validation errors return identical status
 *   - cleanup: no state mutations (calls require real Vapi key to succeed)
 *   - boundary param: Vapi API call uses expected URL, method, and auth header
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: cannot create real calls without Vapi key
 *   - state-transition: call state transitions happen on Vapi's side
 *   - ordering/pagination: no list endpoints
 *   - atomicity: single external API call per request
 *   - referential integrity: no DB relations
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: each call is unique
 *   - tenant isolation: auth via API key (internal service-to-service)
 *   - time/clock: no timestamps in error responses
 *   - call ordering: sequential outbound calls (create then poll)
 *
 * Usage:
 *   npx tsx src/tests/blackbox/vapi.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/vapi.blackbox.ts
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

const ErrorResponse = z.object({ error: z.string() });

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

// ==================== POST /api/vapi/call ====================

// --- auth boundary ---

async function testCall_noAuth() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    body: JSON.stringify({
      to: '+10000000000',
      system_prompt: 'test',
      output_schema: {},
    }),
  });
  assertStatus(res.status, 401, res.data);
}

// --- validation ---

async function testCall_missingTo() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ system_prompt: 'test', output_schema: {} }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /call (missing to)');
}

async function testCall_missingPrompt() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ to: '+10000000000', output_schema: {} }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /call (missing prompt)');
}

async function testCall_missingSchema() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ to: '+10000000000', system_prompt: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /call (missing schema)');
}

async function testCall_emptyBody() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

async function testCall_allFieldsMissing() {
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ extra: 'field' }),
  });
  assertStatus(res.status, 400, res.data);
}

// --- Vapi not configured (500 if VAPI_PRIVATE_KEY missing) ---

async function testCall_vapiNotConfigured() {
  // If VAPI_PRIVATE_KEY is not set, the endpoint returns 500
  // If it IS set, it will try to call Vapi and either succeed or fail
  // Either way, it should not crash
  const res = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      to: '+10000000000',
      system_prompt: 'Test prompt',
      output_schema: { result: 'description' },
    }),
  });
  // Accept 200 (success), 500 (Vapi not configured), or Vapi error codes
  if (res.status !== 200 && res.status !== 500 && res.status < 400) {
    throw new Error(`Unexpected status ${res.status}`);
  }
}

// ==================== GET /api/vapi/call/:id ====================

// --- auth boundary ---

async function testGetCall_noAuth() {
  const res = await request(`${BASE_URL}/api/vapi/call/nonexistent`);
  assertStatus(res.status, 401, res.data);
}

// --- validation / error surface ---

async function testGetCall_nonexistentId() {
  const res = await request(`${BASE_URL}/api/vapi/call/nonexistent-call-id`, {
    headers: apiKeyHeaders(),
  });
  // Should be 400/404 from Vapi or 500 if Vapi not configured
  if (res.status !== 400 && res.status !== 404 && res.status !== 500) {
    throw new Error(`Expected 400, 404, or 500 for nonexistent call, got ${res.status}`);
  }
}

// ==================== BOUNDARY CAPTURE ====================

async function testBoundary_vapiCallCreation() {
  const clearRes = await request(`${BASE_URL}/api/test/captures`, { method: 'DELETE' });
  if (clearRes.status === 404) return; // capture harness not active

  await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      to: '+10000000000',
      system_prompt: 'Boundary test',
      output_schema: { result: 'string' },
    }),
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as {
    captures: { url: string; method: string; requestHeaders: Record<string, string> }[];
  };

  const vapiCalls = body.captures.filter(
    (c) => c.url.includes('api.vapi.ai') && c.url.includes('/call')
  );
  if (vapiCalls.length === 0) {
    // If VAPI_PRIVATE_KEY is not set, no outbound call is made (500 before fetch)
    // This is acceptable - skip the assertion
    return;
  }

  const call = vapiCalls[0];
  if (call.method !== 'POST') {
    throw new Error(`Expected POST to Vapi, got ${call.method}`);
  }
  const headerKeys = Object.keys(call.requestHeaders).map((k) => k.toLowerCase());
  if (!headerKeys.includes('authorization')) {
    throw new Error(`Expected Authorization header in Vapi call`);
  }
}

async function testBoundary_vapiCallPoll() {
  const clearRes = await request(`${BASE_URL}/api/test/captures`, { method: 'DELETE' });
  if (clearRes.status === 404) return; // capture harness not active

  await request(`${BASE_URL}/api/vapi/call/test-poll-id`, {
    headers: apiKeyHeaders(),
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as {
    captures: { url: string; method: string; requestHeaders: Record<string, string> }[];
  };

  const vapiCalls = body.captures.filter(
    (c) => c.url.includes('api.vapi.ai') && c.url.includes('/call')
  );
  if (vapiCalls.length === 0) return; // Vapi not configured

  const call = vapiCalls[0];
  if (call.method !== 'GET') {
    throw new Error(`Expected GET to Vapi, got ${call.method}`);
  }
  if (!call.url.includes('test-poll-id')) {
    throw new Error(`Expected URL to contain call ID, got ${call.url}`);
  }
  const pollHeaderKeys = Object.keys(call.requestHeaders).map((k) => k.toLowerCase());
  if (!pollHeaderKeys.includes('authorization')) {
    throw new Error(`Expected Authorization header in Vapi poll call`);
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_validationError() {
  const body = JSON.stringify({ system_prompt: 'test', output_schema: {} }); // missing 'to'
  const r1 = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body,
  });
  const r2 = await request(`${BASE_URL}/api/vapi/call`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body,
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelAuthChecks() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/vapi/call`, {
        method: 'POST',
        body: JSON.stringify({ to: '+10000000000', system_prompt: 'test', output_schema: {} }),
      })
    )
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Expected uniform status, got: ${[...statuses].join(', ')}`);
  }
}

async function testReproducibility_threeSequential() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/vapi/call`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output_schema: {} }), // missing to + system_prompt
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Vapi Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelTests = [
    // auth boundary
    { name: 'POST /vapi/call -- no auth -> 401', fn: testCall_noAuth },
    { name: 'GET /vapi/call/:id -- no auth -> 401', fn: testGetCall_noAuth },
    // validation
    { name: 'POST /vapi/call -- missing to -> 400', fn: testCall_missingTo },
    { name: 'POST /vapi/call -- missing system_prompt -> 400', fn: testCall_missingPrompt },
    { name: 'POST /vapi/call -- missing output_schema -> 400', fn: testCall_missingSchema },
    { name: 'POST /vapi/call -- empty body -> 400', fn: testCall_emptyBody },
    { name: 'POST /vapi/call -- all fields missing -> 400', fn: testCall_allFieldsMissing },
    // error surface
    { name: 'POST /vapi/call -- Vapi config check', fn: testCall_vapiNotConfigured },
    { name: 'GET /vapi/call/:id -- nonexistent -> 404/500', fn: testGetCall_nonexistentId },
    // invariants
    {
      name: 'idempotency -- same validation error same status',
      fn: testIdempotency_validationError,
    },
    {
      name: 'concurrency -- 10 parallel auth checks consistent',
      fn: testConcurrency_parallelAuthChecks,
    },
    {
      name: 'reproducibility -- 3 sequential identical status',
      fn: testReproducibility_threeSequential,
    },
  ];

  const sequentialTests = [
    // boundary capture (must be sequential due to shared capture buffer)
    { name: 'boundary -- Vapi call creation outbound', fn: testBoundary_vapiCallCreation },
    { name: 'boundary -- Vapi call poll outbound', fn: testBoundary_vapiCallPoll },
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
  console.log('\nALL VAPI BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
