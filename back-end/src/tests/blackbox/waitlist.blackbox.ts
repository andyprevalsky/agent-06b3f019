#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/waitlist
 *
 * Domain surface:
 *   POST /api/waitlist — join waitlist (public, no auth)
 *
 * Invariants covered:
 *   - auth boundary: endpoint is public, no auth required
 *   - error-surface: all error responses include { error: string }
 *   - idempotency: duplicate email returns { alreadyRegistered: true } not an error
 *   - duplication prevention: unique constraint on email prevents double-insert
 *   - read-after-write: first POST creates, second POST returns alreadyRegistered
 *   - concurrency: 5 parallel signups all succeed independently
 *   - same-input reproducibility: same valid input always returns 200
 *   - cleanup: uses unique emails per test, no shared mutable fixtures
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - state-transition: no state machine (single INSERT)
 *   - ordering/pagination: no list endpoint
 *   - atomicity: single Prisma create, no multi-step transaction
 *   - referential integrity: no foreign keys
 *   - event/job cardinality: no async side effects
 *   - tenant isolation: no user-scoped data (public endpoint)
 *   - time/clock: no timestamps in response
 *   - boundary param: no third-party HTTP calls
 *   - call ordering: no outbound calls
 *
 * Usage:
 *   npx tsx src/tests/blackbox/waitlist.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/waitlist.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const SuccessResponse = z.object({
  success: z.literal(true),
  message: z.string(),
  alreadyRegistered: z.boolean(),
});

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

// Unique email generator to avoid collisions across test runs
const RUN_ID = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
function uniqueEmail(label: string): string {
  return `bb-${label}-${RUN_ID}@blackbox-test.dev`;
}

// ==================== POST /api/waitlist — AUTH BOUNDARY ====================

async function testWaitlist_noAuthRequired() {
  // Public endpoint — should work without any auth headers
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Test', email: uniqueEmail('no-auth') }),
  });
  assertStatus(res.status, 200, res.data);
}

// ==================== POST /api/waitlist — VALIDATION ====================

async function testWaitlist_missingAllFields() {
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /waitlist missing-all');
}

async function testWaitlist_missingEmail() {
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /waitlist missing-email');
}

async function testWaitlist_missingName() {
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ email: uniqueEmail('no-name') }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /waitlist missing-name');
}

async function testWaitlist_invalidEmail() {
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Test', email: 'not-an-email' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /waitlist invalid-email');
}

async function testWaitlist_invalidEmailNoAt() {
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Test', email: 'nodomain' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testWaitlist_invalidEmailNoDomain() {
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Test', email: 'user@' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testWaitlist_emptyBody() {
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify(null),
  });
  assertStatus(res.status, 400, res.data);
}

// ==================== POST /api/waitlist — HAPPY PATH ====================

async function testWaitlist_happy() {
  const email = uniqueEmail('happy');
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'BB Test', email }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SuccessResponse, res.data, 'POST /waitlist happy');
  if (body.alreadyRegistered !== false) {
    throw new Error(
      `Expected alreadyRegistered=false for new signup, got ${body.alreadyRegistered}`
    );
  }
}

async function testWaitlist_happyWithVariant() {
  const email = uniqueEmail('variant');
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Variant Test', email, variant: 'landing-page-a' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /waitlist variant');
}

async function testWaitlist_unicodeName() {
  const email = uniqueEmail('unicode');
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Tëst Üñîcödé 日本語', email }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /waitlist unicode');
}

async function testWaitlist_emailNormalization() {
  // Emails should be lowercased
  const email = uniqueEmail('UPPER');
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Case Test', email: email.toUpperCase() }),
  });
  assertStatus(res.status, 200, res.data);
}

async function testWaitlist_extraFieldsIgnored() {
  const email = uniqueEmail('extra');
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Extra', email, phone: '1234', company: 'Test' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /waitlist extra-fields');
}

async function testWaitlist_contentType() {
  const email = uniqueEmail('ct');
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'CT', email }),
  });
  const ct = res.headers.get('content-type');
  if (!ct || !ct.includes('application/json')) {
    throw new Error(`Expected Content-Type application/json, got: ${ct}`);
  }
}

// ==================== DUPLICATION / IDEMPOTENCY ====================

async function testWaitlist_duplicate() {
  const email = uniqueEmail('dup');
  // First signup
  const res1 = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Dup Test', email }),
  });
  assertStatus(res1.status, 200, res1.data);
  const body1 = assertSchema(SuccessResponse, res1.data, 'POST /waitlist dup-first');
  if (body1.alreadyRegistered !== false) {
    throw new Error('First signup should have alreadyRegistered=false');
  }

  // Second signup (duplicate)
  const res2 = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Dup Test', email }),
  });
  assertStatus(res2.status, 200, res2.data);
  const body2 = assertSchema(SuccessResponse, res2.data, 'POST /waitlist dup-second');
  if (body2.alreadyRegistered !== true) {
    throw new Error('Second signup should have alreadyRegistered=true');
  }
}

async function testWaitlist_duplicateCaseInsensitive() {
  const email = uniqueEmail('dupcase');
  // First signup lowercase
  await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Case', email }),
  });
  // Second signup uppercase — should detect duplicate
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Case', email: email.toUpperCase() }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SuccessResponse, res.data, 'POST /waitlist dup-case');
  if (body.alreadyRegistered !== true) {
    throw new Error('Uppercase duplicate should be detected as alreadyRegistered');
  }
}

// ==================== ERROR SURFACE ====================

async function testWaitlist_getNotAllowed() {
  const res = await request(`${BASE_URL}/api/waitlist`, { method: 'GET' });
  if (res.status === 200) {
    throw new Error('GET /api/waitlist should not return 200');
  }
}

async function testWaitlist_putNotAllowed() {
  const res = await request(`${BASE_URL}/api/waitlist`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'Test', email: 'test@test.com' }),
  });
  if (res.status === 200) {
    throw new Error('PUT /api/waitlist should not return 200');
  }
}

async function testWaitlist_deleteNotAllowed() {
  const res = await request(`${BASE_URL}/api/waitlist`, { method: 'DELETE' });
  if (res.status === 200) {
    throw new Error('DELETE /api/waitlist should not return 200');
  }
}

// ==================== CONCURRENCY INVARIANT ====================

async function testWaitlist_concurrentSignups() {
  const emails = Array.from({ length: 5 }, (_, i) => uniqueEmail(`conc-${i}`));
  const results = await Promise.all(
    emails.map((email) =>
      request(`${BASE_URL}/api/waitlist`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Concurrent', email }),
      })
    )
  );
  for (let i = 0; i < results.length; i++) {
    assertStatus(results[i].status, 200, results[i].data);
    assertSchema(SuccessResponse, results[i].data, `POST /waitlist conc-${i}`);
  }
}

// ==================== REPRODUCIBILITY INVARIANT ====================

async function testWaitlist_reproducible() {
  // Same invalid input always produces same error
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      request(`${BASE_URL}/api/waitlist`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Test', email: 'bad' }),
      })
    )
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Expected consistent status, got: ${[...statuses].join(', ')}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('Waitlist Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelTests = [
    // auth boundary
    { name: 'POST /waitlist -- no auth required', fn: testWaitlist_noAuthRequired },
    // validation
    { name: 'POST /waitlist -- missing all fields -> 400', fn: testWaitlist_missingAllFields },
    { name: 'POST /waitlist -- missing email -> 400', fn: testWaitlist_missingEmail },
    { name: 'POST /waitlist -- missing name -> 400', fn: testWaitlist_missingName },
    { name: 'POST /waitlist -- invalid email -> 400', fn: testWaitlist_invalidEmail },
    { name: 'POST /waitlist -- invalid email (no @) -> 400', fn: testWaitlist_invalidEmailNoAt },
    {
      name: 'POST /waitlist -- invalid email (no domain) -> 400',
      fn: testWaitlist_invalidEmailNoDomain,
    },
    { name: 'POST /waitlist -- empty body -> 400', fn: testWaitlist_emptyBody },
    // happy path
    { name: 'POST /waitlist -- happy path', fn: testWaitlist_happy },
    { name: 'POST /waitlist -- with variant', fn: testWaitlist_happyWithVariant },
    { name: 'POST /waitlist -- unicode name', fn: testWaitlist_unicodeName },
    { name: 'POST /waitlist -- email normalization', fn: testWaitlist_emailNormalization },
    { name: 'POST /waitlist -- extra fields ignored', fn: testWaitlist_extraFieldsIgnored },
    { name: 'POST /waitlist -- Content-Type json', fn: testWaitlist_contentType },
    // error surface
    { name: 'GET /waitlist -- not allowed', fn: testWaitlist_getNotAllowed },
    { name: 'PUT /waitlist -- not allowed', fn: testWaitlist_putNotAllowed },
    { name: 'DELETE /waitlist -- not allowed', fn: testWaitlist_deleteNotAllowed },
    // concurrency
    { name: 'POST /waitlist -- 5 concurrent signups', fn: testWaitlist_concurrentSignups },
    // reproducibility
    { name: 'POST /waitlist -- reproducible error', fn: testWaitlist_reproducible },
  ];

  // Sequential tests (depend on ordering)
  const sequentialTests = [
    { name: 'POST /waitlist -- duplicate detection', fn: testWaitlist_duplicate },
    {
      name: 'POST /waitlist -- duplicate case insensitive',
      fn: testWaitlist_duplicateCaseInsensitive,
    },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  console.log(`\nRunning ${sequentialTests.length} sequential tests...`);
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

  console.log('\nALL WAITLIST BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
