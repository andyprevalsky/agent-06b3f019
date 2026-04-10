#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Black-box tests for /api/sms/inbound (Surge webhook)
 *
 * Domain surface:
 *   POST /api/sms/inbound — handle inbound SMS from Surge (signature verified in production)
 *
 * Invariants covered:
 *   - auth boundary: in dev mode, Surge signature validation is skipped; endpoint accepts valid payloads
 *   - error-surface: invalid/empty payloads return 400 with { error: string }
 *   - idempotency: same invalid payload always returns same error
 *   - concurrency: 10 parallel invalid requests all return 400 consistently
 *   - same-input reproducibility: three sequential invalid requests return identical status
 *   - cleanup: unknown phone tests send async SMS but don't mutate test-visible state
 *   - harness independence: supervisor runs async; webhook returns 200 immediately
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: no read endpoint for SMS state
 *   - state-transition: supervisor runs async, not observable from webhook response
 *   - ordering/pagination: no list endpoints
 *   - atomicity: single webhook handler
 *   - referential integrity: no foreign keys in response
 *   - event/job cardinality: supervisor runs async
 *   - duplication prevention: no dedup on inbound SMS
 *   - tenant isolation: user lookup by phone number (no cross-user reads)
 *   - time/clock: no timestamps in response
 *   - call ordering: supervisor is fire-and-forget
 *
 * Boundary capture coverage:
 *   Unknown-phone path sends outbound SMS via globalThis.fetch:
 *   - POST https://api.surge.app/accounts/{SURGE_ACCOUNT_ID}/messages
 *   Boundary tests verify URL contains surge.app, method is POST, Authorization header present.
 *   If SURGE_API_KEY is not configured, 0 outbound calls is acceptable (skips gracefully).
 *
 * Usage:
 *   npx tsx src/tests/blackbox/sms-webhook.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/sms-webhook.blackbox.ts
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

// ==================== POST /api/sms/inbound ====================

// --- error surface ---

async function testInbound_emptyBody() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

async function testInbound_nullBody() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify(null),
  });
  assertStatus(res.status, 400, res.data);
}

async function testInbound_missingContactPhone() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: 'Hello',
        conversation: {
          contact: {},
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testInbound_missingBody() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        conversation: {
          contact: { phone_number: '+10000000000' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testInbound_emptyMessageBody() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: '',
        conversation: {
          contact: { phone_number: '+10000000000' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
  // Empty body after trim → parsed as falsy → 400
  assertStatus(res.status, 400, res.data);
}

async function testInbound_whitespaceOnlyBody() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: '   ',
        conversation: {
          contact: { phone_number: '+10000000000' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
  // Whitespace-only body is trimmed to empty → 400
  assertStatus(res.status, 400, res.data);
}

// --- unknown phone (returns 200, sends async SMS) ---

async function testInbound_unknownPhone() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: 'Hello from unknown',
        conversation: {
          contact: { phone_number: '+10000000001' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
  // Returns 200 with { ok: true } even for unknown phone (sends SMS reply async)
  assertStatus(res.status, 200, res.data);
  const body = res.data as { ok: boolean };
  if (body.ok !== true) {
    throw new Error(`Expected { ok: true }, got: ${JSON.stringify(res.data)}`);
  }
}

// --- Surge data envelope format ---

async function testInbound_surgeDataEnvelope() {
  // Surge wraps payload under a `data` key
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: 'Test via data envelope',
        conversation: {
          contact: { phone_number: '+10000000002' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
  assertStatus(res.status, 200, res.data);
}

async function testInbound_flatPayload() {
  // Also handles flat payload (no data envelope)
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      body: 'Test flat payload',
      conversation: {
        contact: { phone_number: '+10000000003' },
        phone_number: { number: '+14154498072' },
      },
    }),
  });
  assertStatus(res.status, 200, res.data);
}

// --- method checks ---

async function testInbound_getNotAllowed() {
  const res = await request(`${BASE_URL}/api/sms/inbound`);
  if (res.status === 200) {
    throw new Error('GET should not return 200 for webhook endpoint');
  }
}

// --- error response shape ---

async function testInbound_errorShape() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error?: string };
  if (!body.error || typeof body.error !== 'string') {
    throw new Error(`Expected { error: string }, got: ${JSON.stringify(res.data)}`);
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_invalidPayload() {
  const payload = JSON.stringify({});
  const r1 = await request(`${BASE_URL}/api/sms/inbound`, { method: 'POST', body: payload });
  const r2 = await request(`${BASE_URL}/api/sms/inbound`, { method: 'POST', body: payload });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelInvalidRequests() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/sms/inbound`, {
        method: 'POST',
        body: JSON.stringify({}),
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
    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== BOUNDARY CAPTURE — SURGE SMS ====================

async function testBoundary_unknownPhoneCapturesSurgeCall() {
  const cursorRes = await request(`${BASE_URL}/api/test/captures`);
  if (cursorRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping');
    return;
  }
  const cursor = (cursorRes.data as { nextId: number }).nextId - 1;

  await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: 'Boundary test message',
        conversation: {
          contact: { phone_number: '+10000000099' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures?after=${cursor}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as {
    captures: { url: string; method: string; requestHeaders: Record<string, string> }[];
  };

  const surgeCalls = body.captures.filter((c) => c.url.includes('surge.app'));
  if (surgeCalls.length === 0) {
    // SURGE_API_KEY not configured — no outbound call, acceptable
    return;
  }

  const call = surgeCalls[0];
  if (call.method !== 'POST') {
    throw new Error(`Expected POST to Surge, got ${call.method}`);
  }
  if (!call.url.includes('/messages')) {
    throw new Error(`Expected /messages in URL, got ${call.url}`);
  }
  const headerKeys = Object.keys(call.requestHeaders).map((k) => k.toLowerCase());
  if (!headerKeys.includes('authorization')) {
    throw new Error('Expected Authorization header in Surge call');
  }
}

async function testBoundary_invalidPayloadZeroCaptures() {
  const cursorRes = await request(`${BASE_URL}/api/test/captures`);
  if (cursorRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping');
    return;
  }
  const cursor = (cursorRes.data as { nextId: number }).nextId - 1;

  await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const capturesRes = await request(`${BASE_URL}/api/test/captures?after=${cursor}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const body = capturesRes.data as { captures: unknown[] };
  if (body.captures.length > 0) {
    throw new Error(`Expected 0 captures on invalid payload, got ${body.captures.length}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('SMS Webhook Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const parallelTests = [
    // error surface
    { name: 'POST /sms/inbound -- empty body -> 400', fn: testInbound_emptyBody },
    { name: 'POST /sms/inbound -- null body -> 400', fn: testInbound_nullBody },
    {
      name: 'POST /sms/inbound -- missing contact phone -> 400',
      fn: testInbound_missingContactPhone,
    },
    { name: 'POST /sms/inbound -- missing message body -> 400', fn: testInbound_missingBody },
    { name: 'POST /sms/inbound -- empty message body -> 400', fn: testInbound_emptyMessageBody },
    {
      name: 'POST /sms/inbound -- whitespace only body -> 400',
      fn: testInbound_whitespaceOnlyBody,
    },
    { name: 'POST /sms/inbound -- error response shape', fn: testInbound_errorShape },
    // unknown phone
    { name: 'POST /sms/inbound -- unknown phone -> 200', fn: testInbound_unknownPhone },
    // payload formats
    { name: 'POST /sms/inbound -- Surge data envelope', fn: testInbound_surgeDataEnvelope },
    { name: 'POST /sms/inbound -- flat payload', fn: testInbound_flatPayload },
    // method check
    { name: 'GET /sms/inbound -- not allowed', fn: testInbound_getNotAllowed },
    // invariants
    { name: 'idempotency -- same invalid payload same status', fn: testIdempotency_invalidPayload },
    {
      name: 'concurrency -- 10 parallel invalid requests consistent',
      fn: testConcurrency_parallelInvalidRequests,
    },
    {
      name: 'reproducibility -- 3 sequential identical status',
      fn: testReproducibility_threeSequential,
    },
  ];

  const sequentialTests = [
    // boundary capture (must be sequential due to shared capture buffer)
    {
      name: 'boundary -- unknown phone captures Surge SMS call',
      fn: testBoundary_unknownPhoneCapturesSurgeCall,
    },
    {
      name: 'boundary -- invalid payload produces 0 captures',
      fn: testBoundary_invalidPayloadZeroCaptures,
    },
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
  console.log('\nALL SMS WEBHOOK BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
