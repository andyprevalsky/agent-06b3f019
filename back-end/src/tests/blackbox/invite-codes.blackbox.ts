#!/usr/bin/env tsx
/**
 * Black-box tests for the invite-codes domain (part 1: parallel endpoint tests)
 *
 * Covers:
 *   GET  /api/invite-codes/my-code  — get or create user's 6-digit invite code + usage stats
 *   POST /api/invite-codes/use      — request validation + auth boundary
 *   GET  /api/invite-codes/check    — waitlist gate check + user/credit creation
 *
 * The waitlist gate is ON: fresh users get needsInviteCode=true until they
 * redeem a code (existing users were backfilled with the master code).
 *
 * Sequential state-transition tests, waitlist-recording tests, agent-creation
 * gating, and boundary capture tests live in invite-codes.part2.blackbox.ts.
 * Shared infrastructure lives in invite-codes.testkit.ts.
 *
 * Invariants covered here:
 *   - auth boundary: all 3 endpoints reject unauthenticated requests with 401
 *   - error-surface: all error responses include { error: string }
 *   - idempotency: GET /my-code returns same code on repeat; GET /check doesn't duplicate credits
 *   - tenant isolation: one user's invite code is independent of another's
 *   - waitlist gate: fresh users need an invite code
 *
 * Usage:
 *   npx tsx src/tests/blackbox/invite-codes.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/invite-codes.blackbox.ts
 */

import { config } from 'dotenv';
config();

import {
  BASE_URL,
  CASE_CONCURRENCY,
  CheckResponse,
  ErrorResponse,
  MyCodeResponse,
  UsageResponse,
  assert,
  assertSchema,
  assertStatus,
  authHeaders,
  createAnonSession,
  printResults,
  request,
  runPool,
  summarizeAndExit,
} from './invite-codes.testkit';

interface TestContext {
  accessToken1?: string;
  userId1?: string;
}

const ctx: TestContext = {};

// ==================== GET /api/invite-codes/my-code ====================

async function testMyCode_happyPath() {
  const res = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(MyCodeResponse, res.data, 'GET /my-code');
  assert(
    body.inviteCode >= 100000 && body.inviteCode <= 999999,
    `Expected 6-digit invite code, got ${body.inviteCode}`
  );
  assert(body.uses >= 0, `Expected non-negative uses, got ${body.uses}`);
  assert(
    body.usesRemaining >= 0 && body.usesRemaining <= 3,
    `Expected usesRemaining in [0,3], got ${body.usesRemaining}`
  );
}

async function testMyCode_noAuth() {
  const res = await request(`${BASE_URL}/api/invite-codes/my-code`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /my-code no auth');
}

async function testMyCode_invalidJwt() {
  const res = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders('not-a-valid-jwt'),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /my-code invalid jwt');
}

async function testMyCode_idempotent() {
  const { accessToken } = await createAnonSession();
  const res1 = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res1.status, 200, res1.data);
  const body1 = assertSchema(MyCodeResponse, res1.data, 'GET /my-code first call');

  const res2 = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res2.status, 200, res2.data);
  const body2 = assertSchema(MyCodeResponse, res2.data, 'GET /my-code second call');

  assert(
    body1.inviteCode === body2.inviteCode,
    `Expected same invite code on repeat, got ${body1.inviteCode} then ${body2.inviteCode}`
  );
}

async function testMyCode_uniqueAcrossUsers() {
  const [s1, s2] = await Promise.all([createAnonSession(), createAnonSession()]);

  const [r1, r2] = await Promise.all([
    request(`${BASE_URL}/api/invite-codes/my-code`, { headers: authHeaders(s1.accessToken) }),
    request(`${BASE_URL}/api/invite-codes/my-code`, { headers: authHeaders(s2.accessToken) }),
  ]);

  assertStatus(r1.status, 200, r1.data);
  assertStatus(r2.status, 200, r2.data);
  const b1 = assertSchema(MyCodeResponse, r1.data, 'user1 my-code');
  const b2 = assertSchema(MyCodeResponse, r2.data, 'user2 my-code');

  assert(b1.inviteCode !== b2.inviteCode, `Two users got the same invite code: ${b1.inviteCode}`);
}

async function testMyCode_freshUserStartsAt0Uses() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(MyCodeResponse, res.data, 'GET /my-code fresh user');
  assert(body.uses === 0, `Expected 0 uses for fresh user, got ${body.uses}`);
  assert(
    body.usesRemaining === 3,
    `Expected 3 remaining for fresh user, got ${body.usesRemaining}`
  );
}

// ==================== POST /api/invite-codes/use (validation) ====================

async function testUse_noAuth() {
  const res = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    body: JSON.stringify({ inviteCode: 123456 }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /use no auth');
}

async function testUse_missingCode() {
  const res = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /use missing code');
}

async function testUse_invalidCodeType() {
  const res = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ inviteCode: 'not-a-number' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /use invalid type');
}

async function testUse_nullCode() {
  const res = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ inviteCode: null }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /use null code');
}

async function testUse_notFoundCode() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ inviteCode: 999999 }),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /use not found');
}

// ==================== GET /api/invite-codes/check ====================

async function testCheck_gateOnForFreshUser() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CheckResponse, res.data, 'GET /check fresh user');
  assert(
    body.needsInviteCode === true,
    'Expected needsInviteCode: true for a fresh user (waitlist gate ON)'
  );
}

async function testCheck_noAuth() {
  const res = await request(`${BASE_URL}/api/invite-codes/check`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /check no auth');
}

async function testCheck_invalidJwt() {
  const res = await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders('bad-token'),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /check invalid jwt');
}

async function testCheck_createsInitialCredit() {
  const { accessToken } = await createAnonSession();

  // Call /check to trigger user creation + credit initialization
  const checkRes = await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(checkRes.status, 200, checkRes.data);

  // Verify credit was created via /credits/usage
  const usageRes = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(usageRes.status, 200, usageRes.data);
  const usage = assertSchema(UsageResponse, usageRes.data, 'credits/usage after check');
  assert(usage.total > 0, `Expected initial credit > 0, got total=${usage.total}`);
}

async function testCheck_idempotentCreditCreation() {
  const { accessToken } = await createAnonSession();

  // Call /check twice
  await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders(accessToken),
  });
  const usage1Res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(usage1Res.status, 200, usage1Res.data);
  const usage1 = assertSchema(UsageResponse, usage1Res.data, 'usage after first check');

  await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders(accessToken),
  });
  const usage2Res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(usage2Res.status, 200, usage2Res.data);
  const usage2 = assertSchema(UsageResponse, usage2Res.data, 'usage after second check');

  assert(
    usage1.total === usage2.total,
    `Credit duplicated: first=${usage1.total}, second=${usage2.total}`
  );
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testErrorSurface_401sHaveErrorField() {
  const endpoints = [
    { url: `${BASE_URL}/api/invite-codes/my-code`, method: 'GET' as const },
    { url: `${BASE_URL}/api/invite-codes/use`, method: 'POST' as const },
    { url: `${BASE_URL}/api/invite-codes/check`, method: 'GET' as const },
  ];

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const body = ep.method === 'POST' ? JSON.stringify({ inviteCode: 123 }) : undefined;
      const res = await request(ep.url, { method: ep.method, body });
      return { ep, res };
    })
  );

  for (const { ep, res } of results) {
    assertStatus(res.status, 401, res.data);
    assertSchema(ErrorResponse, res.data, `error surface ${ep.method} ${ep.url}`);
  }
}

async function testErrorSurface_400sHaveErrorField() {
  const cases = [
    { url: `${BASE_URL}/api/invite-codes/use`, body: JSON.stringify({}) },
    { url: `${BASE_URL}/api/invite-codes/use`, body: JSON.stringify({ inviteCode: 'string' }) },
    { url: `${BASE_URL}/api/invite-codes/use`, body: JSON.stringify({ inviteCode: null }) },
  ];

  const results = await Promise.all(
    cases.map(async (c) => {
      const res = await request(c.url, {
        method: 'POST',
        headers: authHeaders(ctx.accessToken1!),
        body: c.body,
      });
      return { c, res };
    })
  );

  for (const { c, res } of results) {
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, `error surface POST ${c.url}`);
  }
}

// ==================== TENANT ISOLATION ====================

async function testTenantIsolation_separateInviteCodes() {
  const [s1, s2] = await Promise.all([createAnonSession(), createAnonSession()]);

  const [r1, r2] = await Promise.all([
    request(`${BASE_URL}/api/invite-codes/my-code`, { headers: authHeaders(s1.accessToken) }),
    request(`${BASE_URL}/api/invite-codes/my-code`, { headers: authHeaders(s2.accessToken) }),
  ]);

  assertStatus(r1.status, 200, r1.data);
  assertStatus(r2.status, 200, r2.data);
  const b1 = assertSchema(MyCodeResponse, r1.data, 'isolation user1');
  const b2 = assertSchema(MyCodeResponse, r2.data, 'isolation user2');

  assert(
    b1.inviteCode !== b2.inviteCode,
    `Tenant isolation: both users got same invite code ${b1.inviteCode}`
  );
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Invite Codes Black-box Tests (part 1)\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  const s1 = await createAnonSession();
  ctx.accessToken1 = s1.accessToken;
  ctx.userId1 = s1.userId;
  console.log(`  User 1: ${ctx.userId1}\n`);

  const parallelTests = [
    // GET /my-code
    { name: 'GET /my-code -- happy path + schema', fn: testMyCode_happyPath },
    { name: 'GET /my-code -- no auth -> 401', fn: testMyCode_noAuth },
    { name: 'GET /my-code -- invalid JWT -> 401', fn: testMyCode_invalidJwt },
    { name: 'GET /my-code -- idempotent (same code on repeat)', fn: testMyCode_idempotent },
    { name: 'GET /my-code -- unique codes across users', fn: testMyCode_uniqueAcrossUsers },
    { name: 'GET /my-code -- fresh user starts at 0 uses', fn: testMyCode_freshUserStartsAt0Uses },
    // POST /use
    { name: 'POST /use -- no auth -> 401', fn: testUse_noAuth },
    { name: 'POST /use -- missing code -> 400', fn: testUse_missingCode },
    { name: 'POST /use -- invalid code type -> 400', fn: testUse_invalidCodeType },
    { name: 'POST /use -- null code -> 400', fn: testUse_nullCode },
    { name: 'POST /use -- not found code -> 404', fn: testUse_notFoundCode },
    // GET /check
    { name: 'GET /check -- fresh user needs invite (gate ON)', fn: testCheck_gateOnForFreshUser },
    { name: 'GET /check -- no auth -> 401', fn: testCheck_noAuth },
    { name: 'GET /check -- invalid JWT -> 401', fn: testCheck_invalidJwt },
    { name: 'GET /check -- creates initial credit', fn: testCheck_createsInitialCredit },
    { name: 'GET /check -- idempotent credit creation', fn: testCheck_idempotentCreditCreation },
    // Invariants
    { name: 'error surface -- all 401s have error field', fn: testErrorSurface_401sHaveErrorField },
    { name: 'error surface -- all 400s have error field', fn: testErrorSurface_400sHaveErrorField },
    {
      name: 'tenant isolation -- separate invite codes',
      fn: testTenantIsolation_separateInviteCodes,
    },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);
  printResults(parallelResults);

  summarizeAndExit(parallelResults, 'INVITE CODES (PART 1)');
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
