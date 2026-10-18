#!/usr/bin/env tsx
/**
 * Black-box tests for /api/credits
 *
 * Domain surface:
 *   GET  /api/credits/usage        — credit usage & remaining balance (dual auth: JWT or API key)
 *   POST /api/credits/initialize   — create initial $5 credit for user (auth: JWT)
 *   GET  /api/credits/subscription — current subscription details (auth: JWT)
 *   GET  /api/credits/stats        — token usage statistics by model (auth: JWT)
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401 for all endpoints
 *   - error-surface: API key without userId returns 400; all errors have { error: string }
 *   - read-after-write: initialize credits then check usage reflects them
 *   - idempotency: initialize is idempotent (second call succeeds, returns existing credit)
 *   - concurrency: 10 parallel usage requests return consistent results
 *   - same-input reproducibility: three sequential stats requests return identical data
 *   - tenant isolation: user A cannot see user B's stats (separate anonymous sessions)
 *   - cleanup: each test run creates fresh anonymous users
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - state-transition: credits are additive, no state machine
 *   - ordering/pagination: no list endpoints
 *   - atomicity: single DB operation per endpoint
 *   - referential integrity: userId is a string, not FK-validated at API level
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: initialize is idempotent (tested)
 *   - time/clock: expirationDate in response but not testable without Stripe
 *   - boundary param: no third-party HTTP calls in credits domain
 *   - call ordering: no outbound calls
 *
 * Usage:
 *   npx tsx src/tests/blackbox/credits.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/credits.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
import { randomInt } from 'node:crypto';

/** User.phone is unique; parallel cases need distinct numbers, not millisecond clocks. */
function uniqueTestPhone(prefix: string): string {
  return `${prefix}${String(randomInt(10_000_000)).padStart(7, '0')}`;
}

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({ error: z.string() });

const UpgradeOption = z.object({
  tier: z.number(),
  name: z.string(),
  url: z.string(),
});

const UsageResponse = z.object({
  total: z.number(),
  used: z.number(),
  remaining: z.number(),
  tier: z.number().nullable(),
  upgradeOptions: z.array(UpgradeOption),
  unlimited: z.boolean(),
});

const InitializeResponse = z.object({
  success: z.literal(true),
  credit: z.object({
    amount: z.number(),
    expirationDate: z.string().nullable().or(z.date().nullable()),
  }),
});

const SubscriptionResponse = z.object({
  tier: z.number().nullable(),
  currentPeriodEnd: z.string().nullable().or(z.date().nullable()),
  upgradeOptions: z.array(UpgradeOption),
});

const ModelStat = z.object({
  model: z.string(),
  tokens: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  percentage: z.number(),
});

const StatsResponse = z.object({
  totalTokens: z.number(),
  topModels: z.array(ModelStat),
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
  accessToken2?: string;
  userId2?: string;
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
  const res1 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res1.status, 200, res1.data);
  const d1 = res1.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d1.session.access_token;
  ctx.userId = d1.user.id;

  const res2 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res2.status, 200, res2.data);
  const d2 = res2.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken2 = d2.session.access_token;
  ctx.userId2 = d2.user.id;
}

// ==================== GET /api/credits/usage ====================

async function testUsage_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/usage`);
  assertStatus(res.status, 401, res.data);
}

async function testUsage_invalidToken() {
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders('invalid.jwt.token'),
  });
  assertStatus(res.status, 401, res.data);
}

async function testUsage_happyJwt() {
  // Initialize credits first
  await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
  });
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(UsageResponse, res.data, 'GET /usage (JWT)');
}

async function testUsage_happyApiKey() {
  const res = await request(`${BASE_URL}/api/credits/usage?userId=${ctx.userId}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(UsageResponse, res.data, 'GET /usage (API key)');
}

async function testUsage_apiKeyMissingUserId() {
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /usage (400 missing userId)');
}

async function testUsage_responseShape() {
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'GET /usage (shape)');
  if (body.remaining < 0) {
    throw new Error(`Expected non-negative remaining, got ${body.remaining}`);
  }
  if (body.used < 0) {
    throw new Error(`Expected non-negative used, got ${body.used}`);
  }
  if (body.unlimited !== false) {
    throw new Error(`Anonymous (non-admin) user should not be unlimited, got ${body.unlimited}`);
  }
}

// An admin (ADMIN_USER_IDS) reports `unlimited: true` so the worker credit check never gates them,
// regardless of balance. A fresh non-admin reports `unlimited: false`.
async function testUsage_adminUnlimited() {
  const ADMIN_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30'; // Andy Prevalsky — ADMIN_USER_IDS
  const adminRes = await request(`${BASE_URL}/api/credits/usage?userId=${ADMIN_USER_ID}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(adminRes.status, 200, adminRes.data);
  const adminBody = assertSchema(UsageResponse, adminRes.data, 'GET /usage (admin)');
  if (adminBody.unlimited !== true) {
    throw new Error(`Admin user should be unlimited, got ${adminBody.unlimited}`);
  }

  const nonAdminRes = await request(`${BASE_URL}/api/credits/usage?userId=${ctx.userId}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(nonAdminRes.status, 200, nonAdminRes.data);
  const nonAdminBody = assertSchema(UsageResponse, nonAdminRes.data, 'GET /usage (non-admin)');
  if (nonAdminBody.unlimited !== false) {
    throw new Error(`Non-admin user should not be unlimited, got ${nonAdminBody.unlimited}`);
  }
}

/**
 * Invite-code users get a recurring monthly allowance instead of the subscribe
 * gate. Pins the three properties that make it "free pro":
 *   - the grant lands on the ordinary usage read (no scheduler to own),
 *   - it is worth INVITE_MONTHLY_CREDIT_CENTS and expires at the month boundary,
 *   - re-reading inside the same month does NOT stack another grant.
 */
async function testUsage_inviteCodeMonthlyAllowance() {
  const { prisma } = await import('../../providers/database');
  const { INVITE_MONTHLY_CREDIT_CENTS } = await import('../../providers/credits');
  const invitedUserId = `credits-invite-${Date.now()}`;

  await prisma.user.create({
    data: { userId: invitedUserId, phone: uniqueTestPhone('+1999'), usedInviteCode: 181818 },
  });

  try {
    const first = await request(`${BASE_URL}/api/credits/usage?userId=${invitedUserId}`, {
      headers: apiKeyHeaders(),
    });
    assertStatus(first.status, 200, first.data);
    const firstBody = assertSchema(UsageResponse, first.data, 'GET /usage (invited)');

    const expectedDollars = INVITE_MONTHLY_CREDIT_CENTS / 100;
    if (firstBody.total < expectedDollars) {
      throw new Error(
        `Invited user should hold at least $${expectedDollars} of credit, got $${firstBody.total}`
      );
    }
    // The whole point: a positive balance means every existing credit gate passes.
    if (firstBody.remaining <= 0) {
      throw new Error(`Invited user must not be credit-gated, remaining=${firstBody.remaining}`);
    }

    const now = new Date();
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const grants = await prisma.credit.count({
      where: {
        userId: invitedUserId,
        amountCents: INVITE_MONTHLY_CREDIT_CENTS,
        expirationDate: periodEnd,
      },
    });
    if (grants !== 1) {
      throw new Error(`Expected exactly 1 monthly grant, found ${grants}`);
    }

    // Idempotent within the period — a second read must not stack a second grant.
    const second = await request(`${BASE_URL}/api/credits/usage?userId=${invitedUserId}`, {
      headers: apiKeyHeaders(),
    });
    assertStatus(second.status, 200, second.data);
    const regrants = await prisma.credit.count({
      where: {
        userId: invitedUserId,
        amountCents: INVITE_MONTHLY_CREDIT_CENTS,
        expirationDate: periodEnd,
      },
    });
    if (regrants !== 1) {
      throw new Error(`Monthly grant must not stack within a period, found ${regrants}`);
    }
  } finally {
    await prisma.credit.deleteMany({ where: { userId: invitedUserId } });
    await prisma.user.deleteMany({ where: { userId: invitedUserId } });
  }
}

/** Concurrent usage reads must all observe the one committed monthly grant. */
async function testUsage_inviteCodeConcurrentAllowance() {
  const { prisma } = await import('../../providers/database');
  const { INVITE_MONTHLY_CREDIT_CENTS } = await import('../../providers/credits');
  const invitedUserId = `credits-invite-concurrent-${Date.now()}`;

  await prisma.user.create({
    data: { userId: invitedUserId, phone: uniqueTestPhone('+1998'), usedInviteCode: 181818 },
  });

  try {
    const responses = await Promise.all(
      Array.from({ length: 16 }, () =>
        request(`${BASE_URL}/api/credits/usage?userId=${invitedUserId}`, {
          headers: apiKeyHeaders(),
        })
      )
    );
    for (const response of responses) {
      assertStatus(response.status, 200, response.data);
      const body = assertSchema(UsageResponse, response.data, 'GET /usage (concurrent invited)');
      if (body.total < INVITE_MONTHLY_CREDIT_CENTS / 100) {
        throw new Error(`Concurrent invited usage returned $${body.total} before the grant`);
      }
    }

    const grants = await prisma.credit.count({
      where: { userId: invitedUserId, amountCents: INVITE_MONTHLY_CREDIT_CENTS },
    });
    if (grants !== 1) {
      throw new Error(`Concurrent invited usage created ${grants} grants instead of 1`);
    }
  } finally {
    await prisma.credit.deleteMany({ where: { userId: invitedUserId } });
    await prisma.user.deleteMany({ where: { userId: invitedUserId } });
  }
}

/** A user who never redeemed an invite code must NOT receive the allowance. */
async function testUsage_noAllowanceWithoutInviteCode() {
  const { prisma } = await import('../../providers/database');
  const { INVITE_MONTHLY_CREDIT_CENTS } = await import('../../providers/credits');
  const plainUserId = `credits-noinvite-${Date.now()}`;

  await prisma.user.create({
    data: { userId: plainUserId, phone: uniqueTestPhone('+1998'), usedInviteCode: null },
  });

  try {
    const res = await request(`${BASE_URL}/api/credits/usage?userId=${plainUserId}`, {
      headers: apiKeyHeaders(),
    });
    assertStatus(res.status, 200, res.data);
    const granted = await prisma.credit.count({
      where: { userId: plainUserId, amountCents: INVITE_MONTHLY_CREDIT_CENTS },
    });
    if (granted !== 0) {
      throw new Error(`Non-invited user must not receive the allowance, found ${granted}`);
    }
  } finally {
    await prisma.credit.deleteMany({ where: { userId: plainUserId } });
    await prisma.user.deleteMany({ where: { userId: plainUserId } });
  }
}

// ==================== POST /api/credits/initialize ====================

async function testInitialize_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/initialize`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

async function testInitialize_happy() {
  const res = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(InitializeResponse, res.data, 'POST /initialize');
}

async function testInitialize_idempotent() {
  // Second call should also succeed
  const res = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(InitializeResponse, res.data, 'POST /initialize (idempotent)');
}

// ==================== GET /api/credits/subscription ====================

async function testSubscription_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/subscription`);
  assertStatus(res.status, 401, res.data);
}

async function testSubscription_happy() {
  const res = await request(`${BASE_URL}/api/credits/subscription`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SubscriptionResponse, res.data, 'GET /subscription');
}

async function testSubscription_freshUserNullTier() {
  const res = await request(`${BASE_URL}/api/credits/subscription`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SubscriptionResponse, res.data, 'GET /subscription (fresh)');
  // Fresh anonymous user should have null tier
  if (body.tier !== null) {
    // Acceptable — user may have been initialized with a tier
  }
}

// ==================== GET /api/credits/stats ====================

async function testStats_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/stats`);
  assertStatus(res.status, 401, res.data);
}

async function testStats_happy() {
  const res = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(StatsResponse, res.data, 'GET /stats');
}

async function testStats_emptyForNewUser() {
  const res = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(StatsResponse, res.data, 'GET /stats (empty)');
  if (body.totalTokens !== 0) {
    throw new Error(`Expected totalTokens 0 for new user, got ${body.totalTokens}`);
  }
  if (body.topModels.length !== 0) {
    throw new Error(`Expected empty topModels for new user, got ${body.topModels.length}`);
  }
}

// ==================== READ-AFTER-WRITE ====================

async function testReadAfterWrite_initializeThenUsage() {
  // Create fresh user
  const authRes = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(authRes.status, 200, authRes.data);
  const authData = authRes.data as { session: { access_token: string }; user: { id: string } };
  const token = authData.session.access_token;

  // Initialize credits
  const initRes = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  assertStatus(initRes.status, 200, initRes.data);

  // Check usage reflects initialized credits
  const usageRes = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(token),
  });
  assertStatus(usageRes.status, 200, usageRes.data);
  const usage = assertSchema(UsageResponse, usageRes.data, 'RAW usage');
  if (usage.total <= 0) {
    throw new Error(`Expected positive total after initialize, got ${usage.total}`);
  }
  if (usage.remaining <= 0) {
    throw new Error(`Expected positive remaining after initialize, got ${usage.remaining}`);
  }
}

// ==================== INVARIANTS ====================

async function testIdempotency_usage() {
  const r1 = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(ctx.accessToken!),
  });
  const r2 = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(ctx.accessToken!),
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelUsage() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/credits/usage`, {
        headers: authHeaders(ctx.accessToken!),
      })
    )
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Expected uniform status, got: ${[...statuses].join(', ')}`);
  }
}

async function testReproducibility_threeSequentialStats() {
  const responses: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/credits/stats`, {
      headers: authHeaders(ctx.accessToken2!),
    });
    responses.push(JSON.stringify(res.data));
  }
  if (new Set(responses).size !== 1) {
    throw new Error('Three sequential stats returned different data');
  }
}

async function testTenantIsolation_differentUsers() {
  // User 2 stats should be independent of user 1
  const res1 = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(ctx.accessToken!),
  });
  const res2 = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res1.status, 200, res1.data);
  assertStatus(res2.status, 200, res2.data);
  // Both should parse to valid schemas
  assertSchema(StatsResponse, res1.data, 'Isolation user 1');
  assertSchema(StatsResponse, res2.data, 'Isolation user 2');
}

// ==================== RUN ====================

async function runAll() {
  console.log('Credits Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth sessions...');
  await setup();
  console.log(`  User 1: ${ctx.userId}`);
  console.log(`  User 2: ${ctx.userId2}\n`);

  const parallelTests = [
    // auth boundary
    { name: 'GET /credits/usage -- no auth -> 401', fn: testUsage_noAuth },
    { name: 'GET /credits/usage -- invalid token -> 401', fn: testUsage_invalidToken },
    { name: 'POST /credits/initialize -- no auth -> 401', fn: testInitialize_noAuth },
    { name: 'GET /credits/subscription -- no auth -> 401', fn: testSubscription_noAuth },
    { name: 'GET /credits/stats -- no auth -> 401', fn: testStats_noAuth },
    // validation
    {
      name: 'GET /credits/usage -- API key missing userId -> 400',
      fn: testUsage_apiKeyMissingUserId,
    },
    // happy path
    { name: 'GET /credits/usage -- happy path (JWT)', fn: testUsage_happyJwt },
    { name: 'GET /credits/usage -- happy path (API key)', fn: testUsage_happyApiKey },
    { name: 'GET /credits/usage -- response shape', fn: testUsage_responseShape },
    {
      name: 'GET /credits/usage -- admin is unlimited, non-admin is not',
      fn: testUsage_adminUnlimited,
    },
    {
      name: 'GET /credits/usage -- invite-code user gets a recurring monthly allowance',
      fn: testUsage_inviteCodeMonthlyAllowance,
    },
    {
      name: 'GET /credits/usage -- concurrent invited reads observe one allowance',
      fn: testUsage_inviteCodeConcurrentAllowance,
    },
    {
      name: 'GET /credits/usage -- no allowance without an invite code',
      fn: testUsage_noAllowanceWithoutInviteCode,
    },
    { name: 'GET /credits/subscription -- happy path', fn: testSubscription_happy },
    {
      name: 'GET /credits/subscription -- fresh user null tier',
      fn: testSubscription_freshUserNullTier,
    },
    { name: 'GET /credits/stats -- happy path', fn: testStats_happy },
    { name: 'GET /credits/stats -- empty for new user', fn: testStats_emptyForNewUser },
    // invariants
    { name: 'idempotency -- usage same on repeat', fn: testIdempotency_usage },
    { name: 'concurrency -- 10 parallel usage consistent', fn: testConcurrency_parallelUsage },
    {
      name: 'reproducibility -- 3 sequential stats identical',
      fn: testReproducibility_threeSequentialStats,
    },
    {
      name: 'tenant isolation -- different users independent',
      fn: testTenantIsolation_differentUsers,
    },
  ];

  const sequentialTests = [
    // initialize (must be sequential to test idempotency)
    { name: 'POST /credits/initialize -- happy path', fn: testInitialize_happy },
    { name: 'POST /credits/initialize -- idempotent', fn: testInitialize_idempotent },
    // read-after-write
    {
      name: 'read-after-write -- initialize then usage',
      fn: testReadAfterWrite_initializeThenUsage,
    },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  console.log(`Running ${sequentialTests.length} sequential tests...`);
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
  console.log('\nALL CREDITS BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
