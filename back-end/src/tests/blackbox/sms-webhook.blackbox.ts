#!/usr/bin/env tsx
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
 *   - smoke: known-phone regular SMS reaches supervisor loop and emits outbound SMS response
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
import { PrismaClient } from '@prisma/client';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// Direct Prisma client for assigning a phone number to a User so the webhook
// hits the "known phone" branch.
const prisma = new PrismaClient();

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

async function testInbound_attachmentOnlyPayload() {
  // Media-only MMS (photo/voice note, no text) must be accepted, not dropped.
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: '',
        attachments: [{ url: 'https://example.com/photo.jpg', type: 'image/jpeg' }],
        conversation: {
          contact: { phone_number: '+10000000004' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
  // Unknown phone → 200 with async "unknown phone" SMS; the point is the
  // payload parses instead of 400ing on the empty body.
  assertStatus(res.status, 200, res.data);
}

async function testInbound_invalidAttachmentsStillRejected() {
  // Attachment entries without a usable url don't rescue an empty body.
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: '',
        attachments: [null, 42, { type: 'image/jpeg' }, { url: '' }],
        conversation: {
          contact: { phone_number: '+10000000000' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
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

// ==================== KNOWN-PHONE COVERAGE TESTS ====================
// These tests assign a phone number to a real User row, then exercise the
// "user found" branches of handleInboundSms: /clear and the supervisor route.
// The supervisor LLM call is
// fire-and-forget (c8-ignored) — we assert the webhook returns 200
// immediately and side effects on DB rows we own are visible synchronously.

const SMS_TEST_PHONE_PREFIX = '+1925'; // unique-ish 7-digit space, avoids real test phones

let nextSmsPhoneCounter = 0;
function uniqueSmsPhone(): string {
  nextSmsPhoneCounter++;
  // 4 random digits + 3 monotonic digits, fits NANP layout. Lock to a fixed
  // prefix per process so two parallel test files cannot collide.
  const rand = Math.floor(1000 + Math.random() * 9000);
  const counter = String(nextSmsPhoneCounter).padStart(3, '0');
  return `${SMS_TEST_PHONE_PREFIX}${rand}${counter}`;
}

/**
 * Provision a User with the given phone. Creates the row if missing and
 * always sets the phone field. Returns the User.userId (Supabase auth id).
 */
async function provisionUserWithPhone(phone: string): Promise<string> {
  const userId = `bb-sms-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  await prisma.user.create({
    data: {
      userId,
      phone,
      isAnonymous: true,
    },
  });
  return userId;
}

// Covers service.ts lines 162-179, 203-204 — handleClearCommand path:
// abortAllSupervisorRuns, repo.clearSmsSession, findActiveSmsAgents (returns []
// because we don't seed any agents), then the final sendSms("Session cleared.").
async function testCoverage_clearCommandFromKnownPhone() {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(phone);
  try {
    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          body: '/clear',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    // Verify clearSmsSession was called: SmsSession row should exist with
    // an empty messages array.
    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session) {
      throw new Error('Expected SmsSession row to be upserted by /clear');
    }
    if (session.messages !== JSON.stringify([])) {
      throw new Error(`Expected messages=[], got ${session.messages}`);
    }
  } finally {
    // Clean up DB rows we created so concurrent test runs don't drift.
    await prisma.smsSession.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function testCoverage_codeLikeApprovalRoutesToSupervisor() {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(phone);

  // Seed a legacy-looking shortcode row. Code-shaped SMS text should no longer
  // bypass the supervisor, consume this row, or update the attention request.
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'sms natural approval coverage agent',
      status: 'ACTIVE',
      source: 'SMS',
      temporalWorkflowId: 'wf-bb-sms-natural-approval',
    },
  });
  const attention = await prisma.agentAttentionRequest.create({
    data: {
      userId,
      agentId: agent.id,
      workflowId: 'wf-bb-sms-natural-approval',
      question: 'Can I place the Amazon order for $42?',
    },
  });

  const code = 'AB23K';
  await prisma.smsShortcode.create({
    data: {
      code,
      userId,
      attentionRequestId: attention.id,
      agentId: agent.id,
      workflowId: 'wf-bb-sms-natural-approval',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  try {
    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          body: `Approve ${code}`,
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    const remaining = await prisma.smsShortcode.findFirst({ where: { code, userId } });
    if (!remaining) {
      throw new Error('Code-like SMS should not consume a shortcode row');
    }

    const updated = await prisma.agentAttentionRequest.findUnique({
      where: { id: attention.id },
    });
    if (!updated || updated.userResponse !== null) {
      throw new Error(
        `Code-like SMS should not update attention directly, got "${updated?.userResponse}"`
      );
    }

    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session || session.lastInboundSeq < 1) {
      throw new Error('Code-like SMS should route to supervisor and bump lastInboundSeq');
    }

    await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          body: '/clear',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    await prisma.smsSession.deleteMany({ where: { userId } });
    await prisma.smsShortcode.deleteMany({ where: { userId } });
    await prisma.agentAttentionRequest.deleteMany({ where: { agentId: agent.id } });
    await prisma.agent.deleteMany({ where: { id: agent.id } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

// Covers service.ts line 371 — the "MAIN PATH: routeToSupervisor" branch
// (the function itself is c8-ignored, but the call site at line 371 is not).
// We send a non-shortcode, non-/clear message and assert the webhook returns
// 200 immediately. The supervisor LLM call runs async in the background; we
// follow up with /clear to abort it so it doesn't bleed Surge/LLM captures
// into the next test (boundary -- invalid payload produces 0 captures).
async function testCoverage_routeToSupervisorReturnsImmediately() {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(phone);
  try {
    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          body: 'hi rose, what time is it',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    // /clear aborts the in-flight supervisor (abortAllSupervisorRuns) so the
    // background LLM call cancels promptly. Without this the next sequential
    // boundary test sees stray captures and fails intermittently.
    await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          body: '/clear',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    // Give the abort + Promise.finally chain a few ms to settle.
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    await prisma.smsSession.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

// ==================== SUPERVISOR-PATH TESTS ====================
//
// The supervisor smoke, boundary-capture, and WS-2 deferred-commit tests live
// in src/tests/blackbox/sms-supervisor.blackbox.ts (a sibling domain) so this
// file stays focused on the HTTP-shape invariants of /sms/inbound.

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
    {
      name: 'POST /sms/inbound -- attachment-only payload -> 200',
      fn: testInbound_attachmentOnlyPayload,
    },
    {
      name: 'POST /sms/inbound -- invalid attachments with empty body -> 400',
      fn: testInbound_invalidAttachmentsStillRejected,
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
    // ---- known-phone branch coverage (handleClearCommand and routeToSupervisor
    // call site). Each test provisions its own User row keyed
    // by a synthetic phone so they don't collide with seed data.
    {
      name: 'coverage -- /clear from known phone clears SmsSession',
      fn: testCoverage_clearCommandFromKnownPhone,
    },
    {
      name: 'coverage -- code-like approval routes to supervisor',
      fn: testCoverage_codeLikeApprovalRoutesToSupervisor,
    },
    {
      name: 'coverage -- regular message routes to supervisor (returns 200 immediately)',
      fn: testCoverage_routeToSupervisorReturnsImmediately,
    },
    // Supervisor smoke + boundary tests live in sms-supervisor.blackbox.ts so
    // this domain stays focused on the HTTP-shape invariants of /sms/inbound.
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

  // Disconnect Prisma so the test process exits cleanly.
  await prisma.$disconnect();

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
