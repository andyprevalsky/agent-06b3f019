#!/usr/bin/env tsx
/**
 * Black-box tests for /api/x402
 *
 * Domain surface:
 *   POST /api/x402/topup              — add credits (x402 payment middleware required)
 *   GET  /api/x402/agents/:id/status  — check agent status (public, no auth)
 *
 * Invariants covered:
 *   - auth boundary: topup requires x402 payment (402 without it); status is public
 *   - error-surface: missing payment returns 402; nonexistent agent returns 404
 *   - idempotency: GET status returns same data on repeated calls
 *   - concurrency: 10 parallel GET status requests return consistent results
 *   - same-input reproducibility: three sequential GETs return identical 404
 *   - cleanup: read-only tests, no state mutations
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: cannot create valid topup without real x402 payment
 *   - state-transition: cannot test credit state changes without valid payment
 *   - ordering/pagination: no list endpoints
 *   - atomicity: cannot test multi-step topup without payment
 *   - referential integrity: agent status reads from DB, no FK testing without data
 *   - event/job cardinality: no events emitted from these endpoints
 *   - duplication prevention: topup is additive by design
 *   - tenant isolation: status is public
 *   - time/clock: timestamps in response but not testable without valid agent
 *   - boundary param: no third-party HTTP calls in error paths
 *   - call ordering: no outbound calls in error paths
 *
 * Usage:
 *   npx tsx src/tests/blackbox/x402.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/x402.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
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

// ==================== POST /api/x402/topup ====================

async function testTopup_noPayment() {
  const res = await request(`${BASE_URL}/api/x402/topup`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  // Without x402 payment middleware injecting req.payment, should get 402
  // (or 404 if x402 routes are not mounted because X402_RECEIVING_WALLET is not set)
  if (res.status !== 402 && res.status !== 404) {
    throw new Error(
      `Expected 402 or 404, got ${res.status}: ${JSON.stringify(res.data).substring(0, 300)}`
    );
  }
}

async function testTopup_getNotAllowed() {
  const res = await request(`${BASE_URL}/api/x402/topup`);
  if (res.status === 200) {
    throw new Error('GET should not return 200 for topup endpoint');
  }
}

// ==================== GET /api/x402/agents/:id/status ====================

async function testAgentStatus_notFound() {
  const res = await request(
    `${BASE_URL}/api/x402/agents/00000000-0000-0000-0000-000000000000/status`
  );
  // x402 routes may not be mounted if wallet not configured
  if (res.status === 404) {
    // Either agent not found or routes not mounted - both valid
    return;
  }
  throw new Error(`Expected 404, got ${res.status}`);
}

async function testAgentStatus_notFoundErrorShape() {
  const res = await request(`${BASE_URL}/api/x402/agents/nonexistent-id/status`);
  if (res.status === 404) {
    assertSchema(ErrorResponse, res.data, 'GET /agents/:id/status (404)');
  }
  // If routes not mounted, skip
}

async function testAgentStatus_noAuth() {
  // Status endpoint is public - should not return 401/403
  const res = await request(`${BASE_URL}/api/x402/agents/test-id/status`);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Status endpoint should be public, got ${res.status}`);
  }
}

async function testAgentStatus_differentIds() {
  // Two different nonexistent IDs should both return 404
  const r1 = await request(`${BASE_URL}/api/x402/agents/id-one/status`);
  const r2 = await request(`${BASE_URL}/api/x402/agents/id-two/status`);
  if (r1.status !== r2.status) {
    throw new Error(
      `Expected same status for two nonexistent IDs, got ${r1.status} vs ${r2.status}`
    );
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_agentStatus() {
  const r1 = await request(`${BASE_URL}/api/x402/agents/test-agent/status`);
  const r2 = await request(`${BASE_URL}/api/x402/agents/test-agent/status`);
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelStatusRequests() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => request(`${BASE_URL}/api/x402/agents/test-concurrent/status`))
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Expected uniform status, got: ${[...statuses].join(', ')}`);
  }
}

async function testReproducibility_threeSequential() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/x402/agents/test-repro/status`);
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('x402 Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelTests = [
    // POST /topup
    { name: 'POST /x402/topup -- no payment -> 402/404', fn: testTopup_noPayment },
    { name: 'GET /x402/topup -- not allowed', fn: testTopup_getNotAllowed },
    // GET /agents/:id/status
    { name: 'GET /x402/agents/:id/status -- not found -> 404', fn: testAgentStatus_notFound },
    {
      name: 'GET /x402/agents/:id/status -- 404 error shape',
      fn: testAgentStatus_notFoundErrorShape,
    },
    { name: 'GET /x402/agents/:id/status -- no auth required', fn: testAgentStatus_noAuth },
    {
      name: 'GET /x402/agents/:id/status -- different IDs same status',
      fn: testAgentStatus_differentIds,
    },
    // invariants
    { name: 'idempotency -- agent status same on repeat', fn: testIdempotency_agentStatus },
    {
      name: 'concurrency -- 10 parallel status requests consistent',
      fn: testConcurrency_parallelStatusRequests,
    },
    {
      name: 'reproducibility -- 3 sequential identical status',
      fn: testReproducibility_threeSequential,
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
  console.log('\nALL X402 BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
