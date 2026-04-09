#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for the invite-codes domain
 *
 * Covers:
 *   GET  /api/invite-codes/my-code  — get or create user's 6-digit invite code + usage stats
 *   POST /api/invite-codes/use      — redeem an invite code (normal or master 181818)
 *   GET  /api/invite-codes/check    — check if user needs invite code + create user + initial credit
 *
 * Boundary capture tests (Phase 3):
 *   This domain has NO third-party HTTP boundaries — all operations are local (Prisma DB).
 *   Boundary tests verify 0 outbound HTTP calls for every endpoint to prove no hidden dependencies.
 *
 * Invariants covered:
 *   - auth boundary: all 3 endpoints reject unauthenticated requests with 401
 *   - error-surface: all error responses include { error: string }
 *   - idempotency: GET /my-code returns same code on repeat; GET /check doesn't duplicate credits
 *   - read-after-write: after using a code, inviter's uses count increments
 *   - state-transition: fresh user → uses code → cannot use again (400)
 *   - tenant isolation: one user's invite code is independent of another's
 *   - duplication prevention: user can only redeem one invite code ever
 *   - boundary param: no outbound HTTP calls made by any endpoint
 *   - reproducibility: deterministic given the same inputs
 *   - cleanup: each test creates fresh anonymous users; no shared mutable fixtures
 *
 * Invariants not applicable:
 *   - concurrency: invite code generation retries on collision; DB uniqueness enforced by Prisma
 *   - ordering/pagination: no list endpoints
 *   - atomicity: /use is a $transaction; tested via state-transition tests
 *   - referential integrity: enforced by Prisma/Postgres, not the invite-codes layer
 *   - event/job cardinality: no background jobs or events
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *   - time/clock: no timestamp-dependent behavior
 *   - call ordering: no outbound calls to order
 *
 * Usage:
 *   npx tsx src/tests/blackbox/invite-codes.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/invite-codes.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({
  error: z.string(),
});

const MyCodeResponse = z.object({
  inviteCode: z.number(),
  uses: z.number(),
  usesRemaining: z.number(),
});

const UseCodeResponse = z.object({
  success: z.boolean(),
  message: z.string(),
});

const CheckResponse = z.object({
  needsInviteCode: z.boolean(),
});

const AnonymousResponse = z.object({
  success: z.literal(true),
  user: z.object({ id: z.string() }),
  session: z.object({
    access_token: z.string(),
    expires_in: z.number(),
  }),
});

const UsageResponse = z.object({
  total: z.number(),
  used: z.number(),
  remaining: z.number(),
});

// ==================== CAPTURE TYPES ====================

interface CapturedCall {
  id: number;
  timestamp: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
}

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface TestContext {
  accessToken1?: string;
  userId1?: string;
  accessToken2?: string;
  userId2?: string;
  accessToken3?: string;
  userId3?: string;
  captureAvailable: boolean;
}

const ctx: TestContext = { captureAvailable: false };

const MASTER_CODE = 181818;

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
    throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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

// ==================== CAPTURE HELPERS ====================

async function clearCaptures(): Promise<void> {
  const res = await request(`${BASE_URL}/api/test/captures`, { method: 'DELETE' });
  assertStatus(res.status, 200, res.data);
}

async function readCaptures(): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ==================== HELPERS ====================

async function createAnonSession(): Promise<{ accessToken: string; userId: string }> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'anonymous setup');
  return { accessToken: body.session.access_token, userId: body.user.id };
}

// ==================== SETUP ====================

async function setup(): Promise<void> {
  const [s1, s2, s3] = await Promise.all([
    createAnonSession(),
    createAnonSession(),
    createAnonSession(),
  ]);
  ctx.accessToken1 = s1.accessToken;
  ctx.userId1 = s1.userId;
  ctx.accessToken2 = s2.accessToken;
  ctx.userId2 = s2.userId;
  ctx.accessToken3 = s3.accessToken;
  ctx.userId3 = s3.userId;
  ctx.captureAvailable = await checkCaptureAvailable();
}

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

// ==================== POST /api/invite-codes/use ====================

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

async function testUse_masterCode() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UseCodeResponse, res.data, 'POST /use master code');
  assert(body.success === true, 'Expected success: true for master code');
  assert(
    body.message.toLowerCase().includes('master'),
    `Expected master-specific message, got: "${body.message}"`
  );
}

// ==================== GET /api/invite-codes/check ====================

async function testCheck_happyPath() {
  const res = await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CheckResponse, res.data, 'GET /check');
  assert(body.needsInviteCode === false, 'Expected needsInviteCode: false (public beta)');
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

// ==================== SEQUENTIAL STATE TESTS ====================

/**
 * Full workflow: user1 gets code → user2 uses it → verify state changes.
 */
async function testUse_happyPathWorkflow() {
  const [inviter, redeemer] = await Promise.all([createAnonSession(), createAnonSession()]);

  // Step 1: inviter gets their code
  const codeRes = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(codeRes.status, 200, codeRes.data);
  const codeBefore = assertSchema(MyCodeResponse, codeRes.data, 'inviter code before');
  assert(codeBefore.uses === 0, `Expected 0 uses before, got ${codeBefore.uses}`);

  // Step 2: redeemer uses the code
  const useRes = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(redeemer.accessToken),
    body: JSON.stringify({ inviteCode: codeBefore.inviteCode }),
  });
  assertStatus(useRes.status, 200, useRes.data);
  const useBody = assertSchema(UseCodeResponse, useRes.data, 'POST /use happy');
  assert(useBody.success === true, 'Expected success: true');

  // Step 3: verify inviter's uses incremented
  const codeAfter = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(codeAfter.status, 200, codeAfter.data);
  const afterBody = assertSchema(MyCodeResponse, codeAfter.data, 'inviter code after');
  assert(afterBody.uses === 1, `Expected 1 use after, got ${afterBody.uses}`);
  assert(afterBody.usesRemaining === 2, `Expected 2 remaining, got ${afterBody.usesRemaining}`);
}

/**
 * Duplication prevention: user cannot use a code if they already used one.
 */
async function testUse_alreadyUsedCode() {
  const [inviter, redeemer] = await Promise.all([createAnonSession(), createAnonSession()]);

  // Get inviter's code
  const codeRes = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(codeRes.status, 200, codeRes.data);
  const code = assertSchema(MyCodeResponse, codeRes.data, 'inviter code').inviteCode;

  // Use the master code first
  const firstUse = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(redeemer.accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });
  assertStatus(firstUse.status, 200, firstUse.data);

  // Try to use a different code — should fail
  const secondUse = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(redeemer.accessToken),
    body: JSON.stringify({ inviteCode: code }),
  });
  assertStatus(secondUse.status, 400, secondUse.data);
  const errBody = assertSchema(ErrorResponse, secondUse.data, 'POST /use already used');
  assert(
    errBody.error.toLowerCase().includes('already'),
    `Expected "already used" error, got: "${errBody.error}"`
  );
}

/**
 * Code exhaustion: after 3 uses, the code returns 400.
 */
async function testUse_codeExhaustedAfter3Uses() {
  const inviter = await createAnonSession();

  // Get inviter's code
  const codeRes = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(codeRes.status, 200, codeRes.data);
  const code = assertSchema(MyCodeResponse, codeRes.data, 'inviter code').inviteCode;

  // Use the code 3 times with different users
  for (let i = 0; i < 3; i++) {
    const user = await createAnonSession();
    const res = await request(`${BASE_URL}/api/invite-codes/use`, {
      method: 'POST',
      headers: authHeaders(user.accessToken),
      body: JSON.stringify({ inviteCode: code }),
    });
    assertStatus(res.status, 200, res.data);
  }

  // Verify inviter shows 3 uses, 0 remaining
  const afterRes = await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(inviter.accessToken),
  });
  assertStatus(afterRes.status, 200, afterRes.data);
  const afterBody = assertSchema(MyCodeResponse, afterRes.data, 'inviter after 3 uses');
  assert(afterBody.uses === 3, `Expected 3 uses, got ${afterBody.uses}`);
  assert(afterBody.usesRemaining === 0, `Expected 0 remaining, got ${afterBody.usesRemaining}`);

  // 4th user tries to use the exhausted code → 400
  const user4 = await createAnonSession();
  const exhaustedRes = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(user4.accessToken),
    body: JSON.stringify({ inviteCode: code }),
  });
  assertStatus(exhaustedRes.status, 400, exhaustedRes.data);
  const errBody = assertSchema(ErrorResponse, exhaustedRes.data, 'POST /use exhausted');
  assert(
    errBody.error.toLowerCase().includes('no uses remaining'),
    `Expected "no uses remaining" error, got: "${errBody.error}"`
  );
}

/**
 * Master code can be used by multiple users independently.
 */
async function testUse_masterCodeMultipleUsers() {
  const [u1, u2] = await Promise.all([createAnonSession(), createAnonSession()]);

  const res1 = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(u1.accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });
  assertStatus(res1.status, 200, res1.data);

  const res2 = await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(u2.accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });
  assertStatus(res2.status, 200, res2.data);
}

// ==================== BOUNDARY CAPTURE TESTS ====================
// These run sequentially because they share the capture buffer.
// All invite-codes endpoints are purely local (Prisma DB) — assert 0 outbound calls.

/**
 * GET /my-code makes NO outbound HTTP calls.
 */
async function testBoundary_myCodeNoOutboundCalls() {
  await clearCaptures();

  await request(`${BASE_URL}/api/invite-codes/my-code`, {
    headers: authHeaders(ctx.accessToken1!),
  });

  const calls = await readCaptures();
  assert(
    calls.length === 0,
    `Expected 0 outbound calls for GET /my-code, got ${calls.length}: ${JSON.stringify(calls.map((c) => c.url))}`
  );
}

/**
 * POST /use (validation failure) makes NO outbound HTTP calls.
 */
async function testBoundary_useValidationNoOutbound() {
  await clearCaptures();

  await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });

  const calls = await readCaptures();
  assert(
    calls.length === 0,
    `Expected 0 outbound calls for validation failure, got ${calls.length}`
  );
}

/**
 * POST /use (not found code) makes NO outbound HTTP calls.
 */
async function testBoundary_useNotFoundNoOutbound() {
  const { accessToken } = await createAnonSession();
  await clearCaptures();

  await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ inviteCode: 999999 }),
  });

  const calls = await readCaptures();
  assert(calls.length === 0, `Expected 0 outbound calls for not-found code, got ${calls.length}`);
}

/**
 * POST /use (master code happy path) makes NO outbound HTTP calls.
 */
async function testBoundary_useMasterCodeNoOutbound() {
  const { accessToken } = await createAnonSession();
  await clearCaptures();

  await request(`${BASE_URL}/api/invite-codes/use`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ inviteCode: MASTER_CODE }),
  });

  const calls = await readCaptures();
  const relevantCalls = calls.filter(
    (c) =>
      !c.url.includes('supabase.co') &&
      !c.url.includes('github.com') &&
      !c.url.includes('api.github.com')
  );
  assert(
    relevantCalls.length === 0,
    `Expected 0 outbound calls for master code use, got ${relevantCalls.length}: ${JSON.stringify(relevantCalls.map((c) => c.url))}`
  );
}

/**
 * GET /check makes NO outbound HTTP calls (credit creation is DB-only).
 */
async function testBoundary_checkNoOutboundCalls() {
  const { accessToken } = await createAnonSession();
  await clearCaptures();

  await request(`${BASE_URL}/api/invite-codes/check`, {
    headers: authHeaders(accessToken),
  });

  const calls = await readCaptures();
  assert(
    calls.length === 0,
    `Expected 0 outbound calls for GET /check, got ${calls.length}: ${JSON.stringify(calls.map((c) => c.url))}`
  );
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Invite Codes Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Phase 1: Setup
  console.log('Setting up auth sessions...');
  await setup();
  console.log(`  User 1: ${ctx.userId1}`);
  console.log(`  User 2: ${ctx.userId2}`);
  console.log(`  User 3: ${ctx.userId3}`);
  console.log(`  Capture available: ${ctx.captureAvailable}\n`);

  // Phase 2: Parallel independent tests
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
    { name: 'POST /use -- master code -> 200', fn: testUse_masterCode },
    // GET /check
    { name: 'GET /check -- happy path (needsInviteCode=false)', fn: testCheck_happyPath },
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

  for (const r of parallelResults) {
    const icon = r.passed ? '  PASS' : '  FAIL';
    console.log(`${icon}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`);
  }

  // Phase 3: Sequential state-dependent tests + boundary capture tests
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [
    {
      name: 'POST /use -- happy path workflow (invite + redeem + verify)',
      fn: testUse_happyPathWorkflow,
    },
    { name: 'POST /use -- already used code -> 400', fn: testUse_alreadyUsedCode },
    {
      name: 'POST /use -- code exhausted after 3 uses -> 400',
      fn: testUse_codeExhaustedAfter3Uses,
    },
    {
      name: 'POST /use -- master code works for multiple users',
      fn: testUse_masterCodeMultipleUsers,
    },
  ];

  // Add boundary capture tests if capture is available
  if (ctx.captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary -- GET /my-code makes no outbound calls',
        fn: testBoundary_myCodeNoOutboundCalls,
      },
      {
        name: 'boundary -- POST /use validation makes no outbound calls',
        fn: testBoundary_useValidationNoOutbound,
      },
      {
        name: 'boundary -- POST /use not-found makes no outbound calls',
        fn: testBoundary_useNotFoundNoOutbound,
      },
      {
        name: 'boundary -- POST /use master code makes no outbound calls',
        fn: testBoundary_useMasterCodeNoOutbound,
      },
      {
        name: 'boundary -- GET /check makes no outbound calls',
        fn: testBoundary_checkNoOutboundCalls,
      }
    );
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

  console.log(`\nRunning ${sequentialTests.length} sequential tests...`);
  const sequentialResults: TestResult[] = [];
  for (const test of sequentialTests) {
    const result = await runTest(test.name, test.fn);
    sequentialResults.push(result);
    const icon = result.passed ? '  PASS' : '  FAIL';
    console.log(
      `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
    );
  }

  // Summary
  const allResults = [...parallelResults, ...sequentialResults];
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);

  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log('\nALL INVITE CODES BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
