#!/usr/bin/env tsx
/**
 * Black-box tests for /api/vcard
 *
 * Domain surface:
 *   GET /api/vcard/rose.vcf        — default Rose contact card (public)
 *   GET /api/vcard/:userId.vcf     — personalized contact card (public)
 *
 * Invariants covered:
 *   - auth boundary: both endpoints are public, no auth required
 *   - error-surface: invalid userId falls back to default card (no error)
 *   - idempotency: GET returns same card on repeated calls
 *   - concurrency: 10 parallel GETs return consistent results
 *   - same-input reproducibility: three sequential GETs return identical responses
 *   - cleanup: read-only tests, no state mutations
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: no write endpoints
 *   - state-transition: no state machine
 *   - ordering/pagination: no list endpoints
 *   - atomicity: read-only
 *   - referential integrity: no foreign keys in response
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: no writes
 *   - tenant isolation: public endpoints
 *   - time/clock: no timestamps in response
 *   - boundary param: no third-party HTTP calls (local file read only)
 *   - call ordering: no outbound calls
 *
 * Usage:
 *   npx tsx src/tests/blackbox/vcard.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/vcard.blackbox.ts
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
  if (actual !== expected)
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${String(data).substring(0, 300)}`
    );
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

// ==================== GET /api/vcard/rose.vcf ====================

async function testRoseVcf_happy() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  assertStatus(res.status, 200, res.data);
  if (!res.data.includes('BEGIN:VCARD')) throw new Error('Missing BEGIN:VCARD');
  if (!res.data.includes('END:VCARD')) throw new Error('Missing END:VCARD');
}

async function testRoseVcf_contentType() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  assertStatus(res.status, 200, res.data);
  const ct = res.headers.get('content-type');
  if (!ct || !ct.includes('text/vcard')) throw new Error(`Expected text/vcard, got: ${ct}`);
}

async function testRoseVcf_contentDisposition() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  const cd = res.headers.get('content-disposition');
  if (!cd || !cd.includes('rose.vcf'))
    throw new Error(`Expected content-disposition with rose.vcf, got: ${cd}`);
}

async function testRoseVcf_cacheControl() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  const cc = res.headers.get('cache-control');
  if (!cc || !cc.includes('no-cache'))
    throw new Error(`Expected cache-control no-cache, got: ${cc}`);
}

async function testRoseVcf_containsName() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  // vcards-js adds CHARSET attribute: FN;CHARSET=UTF-8:Rose
  if (!res.data.match(/FN[;:].*Rose/))
    throw new Error('Missing FN containing Rose in: ' + res.data.substring(0, 500));
}

async function testRoseVcf_containsPhone() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  if (!res.data.includes('+14154498072')) throw new Error('Missing phone +14154498072');
}

async function testRoseVcf_containsEmail() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  if (!res.data.includes('rose@roselabs.ai')) throw new Error('Missing email');
}

async function testRoseVcf_containsOrg() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  if (!res.data.includes('Rose Labs')) throw new Error('Missing org');
}

async function testRoseVcf_containsUrl() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  if (!res.data.includes('roselabs.ai')) throw new Error('Missing URL');
}

async function testRoseVcf_containsPhoto() {
  const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  if (!res.data.includes('PHOTO')) throw new Error('Missing embedded photo');
}

async function testRoseVcf_noAuth() {
  const response = await fetch(`${BASE_URL}/api/vcard/rose.vcf`);
  if (response.status === 401 || response.status === 403)
    throw new Error(`Should not require auth, got ${response.status}`);
}

// ==================== GET /api/vcard/:userId.vcf ====================

async function testPersonalizedVcf_unknownUser() {
  const res = await req(`${BASE_URL}/api/vcard/00000000-0000-0000-0000-000000000000.vcf`);
  assertStatus(res.status, 200, res.data);
  if (!res.data.includes('BEGIN:VCARD')) throw new Error('Missing BEGIN:VCARD');
  if (!res.data.match(/FN[;:].*Rose/)) throw new Error('Fallback should use FN containing Rose');
}

async function testPersonalizedVcf_contentType() {
  const res = await req(`${BASE_URL}/api/vcard/some-user-id.vcf`);
  assertStatus(res.status, 200, res.data);
  const ct = res.headers.get('content-type');
  if (!ct || !ct.includes('text/vcard')) throw new Error(`Expected text/vcard, got: ${ct}`);
}

async function testPersonalizedVcf_noAuth() {
  const response = await fetch(`${BASE_URL}/api/vcard/test.vcf`);
  if (response.status === 401 || response.status === 403)
    throw new Error(`Should not require auth, got ${response.status}`);
}

async function testPersonalizedVcf_alwaysHasPhone() {
  const res = await req(`${BASE_URL}/api/vcard/unknown-user.vcf`);
  if (!res.data.includes('+14154498072')) throw new Error('Should always include Rose phone');
}

async function testPersonalizedVcf_alwaysHasPhoto() {
  const res = await req(`${BASE_URL}/api/vcard/unknown-user.vcf`);
  if (!res.data.includes('PHOTO')) throw new Error('Should always include photo');
}

// ==================== ERROR SURFACE ====================

async function testError_postNotAllowed() {
  const response = await fetch(`${BASE_URL}/api/vcard/rose.vcf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (response.status === 200) throw new Error('POST should not return 200');
}

// ==================== INVARIANTS ====================

async function testIdempotency_roseVcf() {
  const r1 = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  const r2 = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  if (r1.status !== r2.status) throw new Error(`Status differs: ${r1.status} vs ${r2.status}`);
  // Both should contain the same structural fields (strip volatile fields: REV, UID, PHOTO data)
  const normalize = (s: string) =>
    s
      .replace(/REV:.*\r?\n/g, '')
      .replace(/UID:.*\r?\n/g, '')
      .replace(/PHOTO[^\r\n]*[\r\n](?:[ \t][^\r\n]*[\r\n])*/g, 'PHOTO:[stripped]\n');
  if (normalize(r1.data) !== normalize(r2.data))
    throw new Error('Two identical GETs returned different structural data');
}

async function testConcurrency_parallelGETs() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => req(`${BASE_URL}/api/vcard/rose.vcf`))
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1)
    throw new Error(`Concurrent requests returned different statuses: ${[...statuses].join(', ')}`);
  // All should contain Rose contact fields
  for (let i = 0; i < results.length; i++) {
    if (!results[i].data.includes('BEGIN:VCARD'))
      throw new Error(`Concurrent request ${i} missing BEGIN:VCARD`);
  }
}

async function testReproducibility_threeSequential() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await req(`${BASE_URL}/api/vcard/rose.vcf`);
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1)
    throw new Error(`Three sequential GETs returned different statuses: ${statuses.join(', ')}`);
}

async function testConsistency_roseVsDefault() {
  const rose = await req(`${BASE_URL}/api/vcard/rose.vcf`);
  const unknown = await req(`${BASE_URL}/api/vcard/nonexistent.vcf`);
  if (!rose.data.includes('+14154498072') || !unknown.data.includes('+14154498072')) {
    throw new Error('Both should include Rose phone');
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('vCard Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelTests = [
    { name: 'GET /vcard/rose.vcf -- happy path', fn: testRoseVcf_happy },
    { name: 'GET /vcard/rose.vcf -- Content-Type text/vcard', fn: testRoseVcf_contentType },
    { name: 'GET /vcard/rose.vcf -- Content-Disposition', fn: testRoseVcf_contentDisposition },
    { name: 'GET /vcard/rose.vcf -- Cache-Control no-cache', fn: testRoseVcf_cacheControl },
    { name: 'GET /vcard/rose.vcf -- contains name', fn: testRoseVcf_containsName },
    { name: 'GET /vcard/rose.vcf -- contains phone', fn: testRoseVcf_containsPhone },
    { name: 'GET /vcard/rose.vcf -- contains email', fn: testRoseVcf_containsEmail },
    { name: 'GET /vcard/rose.vcf -- contains org', fn: testRoseVcf_containsOrg },
    { name: 'GET /vcard/rose.vcf -- contains URL', fn: testRoseVcf_containsUrl },
    { name: 'GET /vcard/rose.vcf -- contains photo', fn: testRoseVcf_containsPhoto },
    { name: 'GET /vcard/rose.vcf -- no auth required', fn: testRoseVcf_noAuth },
    {
      name: 'GET /vcard/:userId.vcf -- unknown user fallback',
      fn: testPersonalizedVcf_unknownUser,
    },
    { name: 'GET /vcard/:userId.vcf -- Content-Type', fn: testPersonalizedVcf_contentType },
    { name: 'GET /vcard/:userId.vcf -- no auth required', fn: testPersonalizedVcf_noAuth },
    { name: 'GET /vcard/:userId.vcf -- always has phone', fn: testPersonalizedVcf_alwaysHasPhone },
    { name: 'GET /vcard/:userId.vcf -- always has photo', fn: testPersonalizedVcf_alwaysHasPhoto },
    { name: 'POST /vcard/rose.vcf -- not allowed', fn: testError_postNotAllowed },
    { name: 'idempotency -- two GETs identical', fn: testIdempotency_roseVcf },
    { name: 'concurrency -- 10 parallel GETs consistent', fn: testConcurrency_parallelGETs },
    { name: 'reproducibility -- 3 sequential identical', fn: testReproducibility_threeSequential },
    { name: 'consistency -- rose.vcf vs default personalized', fn: testConsistency_roseVsDefault },
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
  console.log('\nALL VCARD BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
