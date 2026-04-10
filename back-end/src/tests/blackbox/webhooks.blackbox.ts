#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /webhooks/stripe
 *
 * Domain surface:
 *   POST /webhooks/stripe — handle Stripe webhook events (verified by Stripe signature)
 *
 * Invariants covered:
 *   - auth boundary: requires valid Stripe signature; missing/invalid signature returns 400
 *   - error-surface: invalid signature returns 400 with descriptive error
 *   - idempotency: same invalid request always returns same error
 *   - concurrency: 10 parallel invalid requests all return 400 consistently
 *   - same-input reproducibility: three sequential invalid requests return identical status
 *   - cleanup: read-only tests (no valid events processed), no state mutations
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: cannot test without valid Stripe signature
 *   - state-transition: cannot trigger valid events without Stripe signing secret
 *   - ordering/pagination: no list endpoints
 *   - atomicity: cannot test without valid events
 *   - referential integrity: cannot test without valid events
 *   - event/job cardinality: cannot test without valid events
 *   - duplication prevention: cannot test without valid events
 *   - tenant isolation: events are routed by Stripe customer ID
 *   - time/clock: no timestamps in error responses
 *   - boundary param: Stripe SDK calls are inside event handlers (untestable without valid sig)
 *   - call ordering: cannot test without valid events
 *
 * Usage:
 *   npx tsx src/tests/blackbox/webhooks.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/webhooks.blackbox.ts
 */

import { config } from 'dotenv';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function req(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: string; headers: Headers }> {
  const response = await fetch(url, options);
  const data = await response.text();
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

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${String(data).substring(0, 300)}`
    );
  }
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

// ==================== POST /webhooks/stripe ====================

async function testStripe_noSignature() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'invoice.payment_succeeded' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_invalidSignature() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=1234567890,v1=invalidsignaturehex',
    },
    body: JSON.stringify({ type: 'invoice.payment_succeeded' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_errorContainsWebhookError() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=9999999999,v1=invalidhash',
    },
    body: JSON.stringify({ type: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  if (!res.data.includes('Webhook Error')) {
    throw new Error(
      `Expected error message containing "Webhook Error", got: ${res.data.substring(0, 200)}`
    );
  }
}

async function testStripe_emptyBody() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '',
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_malformedSignatureFormat() {
  const res = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 'not-a-valid-format',
    },
    body: JSON.stringify({ type: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testStripe_getNotAllowed() {
  const res = await req(`${BASE_URL}/webhooks/stripe`);
  // GET should not return 200 (either 404 or 405)
  if (res.status === 200) {
    throw new Error('GET should not return 200 for webhook endpoint');
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_sameInvalidRequest() {
  const body = JSON.stringify({ type: 'test' });
  const r1 = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const r2 = await req(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelInvalidRequests() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      req(`${BASE_URL}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'test' }),
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
    const res = await req(`${BASE_URL}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test' }),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(
      `Three sequential requests returned different statuses: ${statuses.join(', ')}`
    );
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Webhooks (Stripe) Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelTests = [
    { name: 'POST /webhooks/stripe -- no signature -> 400', fn: testStripe_noSignature },
    { name: 'POST /webhooks/stripe -- invalid signature -> 400', fn: testStripe_invalidSignature },
    {
      name: 'POST /webhooks/stripe -- error contains "Webhook Error"',
      fn: testStripe_errorContainsWebhookError,
    },
    { name: 'POST /webhooks/stripe -- empty body -> 400', fn: testStripe_emptyBody },
    {
      name: 'POST /webhooks/stripe -- malformed signature format -> 400',
      fn: testStripe_malformedSignatureFormat,
    },
    { name: 'GET /webhooks/stripe -- not allowed', fn: testStripe_getNotAllowed },
    {
      name: 'idempotency -- same invalid request returns same status',
      fn: testIdempotency_sameInvalidRequest,
    },
    {
      name: 'concurrency -- 10 parallel invalid requests consistent',
      fn: testConcurrency_parallelInvalidRequests,
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
  console.log('\nALL WEBHOOKS BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
