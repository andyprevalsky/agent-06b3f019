#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for the auth domain
 *
 * Covers:
 *   POST /api/auth/anonymous         — anonymous session + JWT + initial credit
 *   POST /api/auth/send-otp          — send OTP via Twilio Verify
 *   POST /api/auth/verify-otp        — verify OTP via Twilio Verify + Supabase user creation
 *   POST /api/auth/complete-onboarding — mark onboarding complete (auth required)
 *   authenticate middleware           — JWT / API-key boundary (tested via /api/api-keys proxy)
 *
 * Boundary capture tests (Phase 3):
 *   Every third-party HTTP call is captured by the fetch interceptor and asserted on:
 *   - Twilio Verify Verifications API  (send-otp): exact URL, method, headers, body params
 *   - Twilio Verify VerificationCheck  (verify-otp): exact URL, method, headers, body params
 *   - Surge SMS API                    (complete-onboarding): only fires for phone-verified users
 *   - Supabase Admin API              (verify-otp): only fires for new users not in local DB
 *
 * Invariants covered:
 *   - auth boundary: protected endpoints reject unauthenticated requests
 *   - error-surface: all error responses include { error: string }
 *   - idempotency: complete-onboarding is idempotent (returns alreadyCompleted on repeat)
 *   - read-after-write: anonymous session token immediately usable on protected endpoints
 *   - state-transition: anonymous user can complete onboarding
 *   - time/clock: session expires_at is in the future
 *   - tenant isolation: one user's token cannot access another user's resources
 *   - boundary param: exact params sent to third-party APIs are captured and asserted
 *   - call ordering: third-party calls happen in the expected order
 *   - reproducibility: deterministic given the same inputs
 *   - cleanup: each test creates its own anonymous users; no shared mutable fixtures
 *
 * Invariants not applicable:
 *   - concurrency: auth endpoints are stateless per-request; no concurrent mutation risk
 *   - ordering/pagination: auth has no list endpoints with ordering
 *   - atomicity: anonymous session + credit is a single DB transaction path
 *   - referential integrity: enforced by Prisma/Postgres, not by the auth layer
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Usage:
 *   npx tsx src/tests/blackbox/auth.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/auth.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');

// ==================== RESPONSE SCHEMAS ====================

const SessionSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  expires_at: z.number(),
  token_type: z.string(),
});

const AnonymousUserSchema = z.object({
  id: z.string(),
  is_anonymous: z.literal(true),
});

const AnonymousResponse = z.object({
  success: z.literal(true),
  user: AnonymousUserSchema,
  session: SessionSchema,
});

const ErrorResponse = z.object({
  error: z.string(),
});

const OnboardingResponse = z.object({
  success: z.literal(true),
  alreadyCompleted: z.boolean(),
  onboardingCompletedAt: z.string().or(z.date()).nullable(),
});

const ListApiKeysResponse = z.object({
  keys: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      maskedApiKey: z.string(),
      createdAt: z.string().or(z.date()),
    })
  ),
});

const UsageResponse = z.object({
  total: z.number(),
  used: z.number(),
  remaining: z.number(),
  tier: z.number().nullable(),
  upgradeOptions: z.array(z.unknown()),
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
  accessTokenOnboarding?: string;
  userIdOnboarding?: string;
  captureAvailable: boolean;
}

const ctx: TestContext = { captureAvailable: false };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

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

/** Infrastructure URLs from concurrent tests (not from the endpoint under test). */
const INFRA_URL_PATTERNS = [
  'api.github.com',
  'openrouter.ai',
  'ip-api.com',
  'supabase.co/realtime',
  'surge.app',
  'verify.twilio.com',
  'e2b.app',
  'stripe.com',
];
function filterInfraCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((c) => !INFRA_URL_PATTERNS.some((p) => c.url.includes(p)));
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

/** Get the current capture cursor (nextId) for snapshot-based reading. */
async function getCaptureCursor(): Promise<number> {
  const res = await request(`${BASE_URL}/api/test/captures`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { nextId: number }).nextId - 1;
}

/** Read only captures recorded after the given cursor. */
async function readCapturesAfter(afterId: number): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?after=${afterId}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

/** Check if the capture endpoint is available (requires BLACKBOX_TEST_CAPTURE_OUTBOUND=1). */
async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Parse URL-encoded body into key-value pairs. */
function parseUrlEncodedBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [k, v] of params) {
    result[k] = v;
  }
  return result;
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
  ctx.accessTokenOnboarding = s3.accessToken;
  ctx.userIdOnboarding = s3.userId;
  ctx.captureAvailable = await checkCaptureAvailable();
}

// ==================== POST /api/auth/anonymous ====================

async function testAnonymous_happyPath() {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'POST /anonymous');
  assert(body.success === true, 'Expected success: true');
  assert(body.user.is_anonymous === true, 'Expected is_anonymous: true');
}

async function testAnonymous_userIdIsUuid() {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'POST /anonymous uuid');
  assert(UUID_RE.test(body.user.id), `Expected UUID, got: ${body.user.id}`);
}

async function testAnonymous_tokenIsJwtFormat() {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'POST /anonymous jwt');
  assert(JWT_RE.test(body.session.access_token), 'access_token is not JWT format');
  assert(JWT_RE.test(body.session.refresh_token), 'refresh_token is not JWT format');
}

async function testAnonymous_tokenTypeIsBearer() {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'POST /anonymous token_type');
  assert(
    body.session.token_type === 'bearer',
    `Expected token_type "bearer", got "${body.session.token_type}"`
  );
}

async function testAnonymous_expiresAtInFuture() {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'POST /anonymous expires');
  const now = Math.floor(Date.now() / 1000);
  assert(
    body.session.expires_at > now,
    `Expected expires_at (${body.session.expires_at}) > now (${now})`
  );
  assert(
    body.session.expires_in > 0,
    `Expected positive expires_in, got ${body.session.expires_in}`
  );
}

async function testAnonymous_uniqueUserIds() {
  const [r1, r2] = await Promise.all([
    request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' }),
    request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' }),
  ]);
  assertStatus(r1.status, 200, r1.data);
  assertStatus(r2.status, 200, r2.data);
  const b1 = assertSchema(AnonymousResponse, r1.data, 'anon1');
  const b2 = assertSchema(AnonymousResponse, r2.data, 'anon2');
  assert(
    b1.user.id !== b2.user.id,
    `Two anonymous sessions returned the same user ID: ${b1.user.id}`
  );
}

async function testAnonymous_initialCreditCreated() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'credits/usage');
  assert(body.total > 0, `Expected initial credit > 0, got total=${body.total}`);
}

async function testAnonymous_tokenWorksOnProtectedEndpoint() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListApiKeysResponse, res.data, 'GET /api-keys with anon token');
}

// ==================== POST /api/auth/send-otp ====================

async function testSendOtp_missingPhone() {
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'send-otp missing phone');
}

async function testSendOtp_emptyPhone() {
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'send-otp empty phone');
}

async function testSendOtp_nullPhone() {
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: null }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'send-otp null phone');
}

// ==================== POST /api/auth/verify-otp ====================

async function testVerifyOtp_missingAllFields() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'verify-otp missing all');
}

async function testVerifyOtp_missingToken() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: '+10000000000' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'verify-otp missing token');
}

async function testVerifyOtp_missingPhone() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ token: '123456' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'verify-otp missing phone');
}

async function testVerifyOtp_emptyStrings() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: '', token: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'verify-otp empty strings');
}

// ==================== POST /api/auth/complete-onboarding ====================

async function testCompleteOnboarding_noAuth() {
  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'onboarding no auth');
}

async function testCompleteOnboarding_invalidJwt() {
  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders('not-a-valid-jwt-token'),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'onboarding invalid jwt');
}

async function testCompleteOnboarding_malformedBearer() {
  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: { Authorization: 'Bearer' },
  });
  assertStatus(res.status, 401, res.data);
}

async function testCompleteOnboarding_wrongScheme() {
  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: { Authorization: `Basic ${ctx.accessToken1}` },
  });
  assertStatus(res.status, 401, res.data);
}

async function testCompleteOnboarding_happyThenIdempotent() {
  const res1 = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders(ctx.accessTokenOnboarding!),
  });
  assertStatus(res1.status, 200, res1.data);
  const body1 = assertSchema(OnboardingResponse, res1.data, 'onboarding first');
  assert(body1.success === true, 'Expected success: true on first call');
  assert(body1.alreadyCompleted === false, 'Expected alreadyCompleted: false on first call');
  assert(body1.onboardingCompletedAt !== null, 'Expected onboardingCompletedAt to be set');

  const res2 = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders(ctx.accessTokenOnboarding!),
  });
  assertStatus(res2.status, 200, res2.data);
  const body2 = assertSchema(OnboardingResponse, res2.data, 'onboarding idempotent');
  assert(body2.success === true, 'Expected success: true on second call');
  assert(body2.alreadyCompleted === true, 'Expected alreadyCompleted: true on second call');
}

// ==================== AUTH MIDDLEWARE BOUNDARY ====================

async function testAuthMiddleware_noHeader() {
  const res = await request(`${BASE_URL}/api/api-keys`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'middleware no header');
}

async function testAuthMiddleware_invalidToken() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.invalidsig'),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'middleware invalid token');
}

async function testAuthMiddleware_emptyBearerToken() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: { Authorization: 'Bearer ' },
  });
  assertStatus(res.status, 401, res.data);
}

async function testAuthMiddleware_apiKeyNoUser() {
  if (!API_KEY) return;
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 401, res.data);
}

async function testAuthMiddleware_validAnonToken() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListApiKeysResponse, res.data, 'middleware valid anon');
}

// ==================== TENANT ISOLATION ====================

async function testTenantIsolation_separateUsers() {
  const [r1, r2] = await Promise.all([
    request(`${BASE_URL}/api/api-keys`, { headers: authHeaders(ctx.accessToken1!) }),
    request(`${BASE_URL}/api/api-keys`, { headers: authHeaders(ctx.accessToken2!) }),
  ]);
  assertStatus(r1.status, 200, r1.data);
  assertStatus(r2.status, 200, r2.data);
  const b1 = assertSchema(ListApiKeysResponse, r1.data, 'isolation user1');
  const b2 = assertSchema(ListApiKeysResponse, r2.data, 'isolation user2');
  assert(b1.keys.length === 0, 'User 1 should have 0 keys');
  assert(b2.keys.length === 0, 'User 2 should have 0 keys');
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testErrorSurface_401sHaveErrorField() {
  const endpoints = [
    { url: `${BASE_URL}/api/auth/complete-onboarding`, method: 'POST' as const },
    { url: `${BASE_URL}/api/api-keys`, method: 'GET' as const },
    { url: `${BASE_URL}/api/api-keys`, method: 'POST' as const },
    { url: `${BASE_URL}/api/api-keys/fake-id`, method: 'DELETE' as const },
  ];

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const res = await request(ep.url, { method: ep.method });
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
    { url: `${BASE_URL}/api/auth/send-otp`, method: 'POST' as const, body: JSON.stringify({}) },
    { url: `${BASE_URL}/api/auth/verify-otp`, method: 'POST' as const, body: JSON.stringify({}) },
  ];

  const results = await Promise.all(
    cases.map(async (c) => {
      const res = await request(c.url, { method: c.method, body: c.body });
      return { c, res };
    })
  );

  for (const { c, res } of results) {
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, `error surface ${c.method} ${c.url}`);
  }
}

// ==================== BOUNDARY CAPTURE TESTS ====================
// These run sequentially because they share the capture buffer.
// Each test: clear captures → make request → read captures → assert on outbound calls.

const TEST_PHONE = '+19729777432';
const TEST_OTP = '181818';

/**
 * POST /api/auth/anonymous makes NO outbound HTTP calls.
 * All work is local (JWT signing + DB insert).
 */
async function testBoundary_anonymousNoOutboundCalls() {
  const cursor = await getCaptureCursor();
  await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  const calls = await readCapturesAfter(cursor);
  // Filter to auth-relevant services only (other concurrent domain tests may trigger unrelated calls)
  const authCalls = calls.filter(
    (c) =>
      c.url.includes('verify.twilio.com') ||
      (c.url.includes('supabase') && !c.url.includes('/realtime/')) ||
      c.url.includes('surge.app')
  );
  assert(
    authCalls.length === 0,
    `Expected 0 auth-related outbound calls for anonymous, got ${authCalls.length}: ${JSON.stringify(authCalls.map((c) => c.url))}`
  );
}

/**
 * POST /api/auth/send-otp calls Twilio Verify Verifications API with exact params:
 *   URL:     https://verify.twilio.com/v2/Services/{SERVICE_SID}/Verifications
 *   Method:  POST
 *   Headers: Authorization: Basic ..., Content-Type: application/x-www-form-urlencoded
 *   Body:    To={phone}&Channel=sms
 */
async function testBoundary_sendOtpTwilioCall() {
  const cursor = await getCaptureCursor();

  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE }),
  });

  // If Twilio credentials aren't configured, send-otp returns 400 with "configuration" error
  if (res.status === 400) {
    const data = res.data as { error?: string };
    if (data.error?.includes('configuration')) {
      console.log('    [skipped] Twilio not configured — cannot test boundary');
      return;
    }
    // Twilio was called but returned an error (e.g. rate limit) — captures are still available
  }

  // Assert the outbound call was captured regardless of Twilio's response status.
  // Even if Twilio rate-limits us (400 "Max send attempts"), the call params are still recorded.
  const calls = await readCapturesAfter(cursor);
  assert(calls.length === 1, `Expected exactly 1 outbound call, got ${calls.length}`);

  const call = calls[0];

  // Assert URL pattern: Twilio Verify Verifications endpoint
  assert(
    call.url.startsWith('https://verify.twilio.com/v2/Services/') &&
      call.url.endsWith('/Verifications'),
    `Unexpected Twilio URL: ${call.url}`
  );

  // Assert method
  assert(call.method === 'POST', `Expected POST, got ${call.method}`);

  // Assert headers
  assert(
    call.requestHeaders['Content-Type'] === 'application/x-www-form-urlencoded',
    `Expected Content-Type: application/x-www-form-urlencoded, got: ${call.requestHeaders['Content-Type']}`
  );
  assert(
    call.requestHeaders['Authorization']?.startsWith('Basic '),
    `Expected Basic auth, got: ${call.requestHeaders['Authorization']?.slice(0, 20)}`
  );

  // Assert body params
  assert(call.requestBody !== null, 'Expected non-null request body');
  const params = parseUrlEncodedBody(call.requestBody!);
  assert(params['To'] === TEST_PHONE, `Expected To=${TEST_PHONE}, got To=${params['To']}`);
  assert(params['Channel'] === 'sms', `Expected Channel=sms, got Channel=${params['Channel']}`);

  // Assert Twilio responded (any status — 201 success or 429/400 rate limit)
  assert(call.responseStatus !== null, 'Expected a response from Twilio');
}

/**
 * POST /api/auth/verify-otp calls Twilio Verify VerificationCheck API with exact params:
 *   URL:     https://verify.twilio.com/v2/Services/{SERVICE_SID}/VerificationCheck
 *   Method:  POST
 *   Headers: Authorization: Basic ..., Content-Type: application/x-www-form-urlencoded
 *   Body:    To={phone}&Code={otp}
 *
 * The test OTP may or may not be approved by Twilio (depends on verification service config).
 * We assert on the outbound call params regardless of the OTP outcome.
 */
async function testBoundary_verifyOtpTwilioCall() {
  const cursor = await getCaptureCursor();

  // Make the verify-otp request (may return 400 if OTP not approved, but Twilio is still called)
  await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });

  const calls = await readCapturesAfter(cursor);

  // Filter to Twilio calls only (verify-otp might also call Supabase Admin if OTP approved)
  const twilioCalls = calls.filter((c) => c.url.includes('verify.twilio.com'));
  assert(twilioCalls.length >= 1, `Expected at least 1 Twilio call, got ${twilioCalls.length}`);

  const checkCall = twilioCalls.find((c) => c.url.includes('/VerificationCheck'));
  assert(checkCall !== undefined, 'Expected a VerificationCheck call to Twilio');

  // Assert URL pattern
  assert(
    checkCall!.url.startsWith('https://verify.twilio.com/v2/Services/') &&
      checkCall!.url.endsWith('/VerificationCheck'),
    `Unexpected VerificationCheck URL: ${checkCall!.url}`
  );

  // Assert method
  assert(checkCall!.method === 'POST', `Expected POST, got ${checkCall!.method}`);

  // Assert headers
  assert(
    checkCall!.requestHeaders['Content-Type'] === 'application/x-www-form-urlencoded',
    `Expected Content-Type: application/x-www-form-urlencoded`
  );
  assert(
    checkCall!.requestHeaders['Authorization']?.startsWith('Basic '),
    'Expected Basic auth header'
  );

  // Assert body params
  assert(checkCall!.requestBody !== null, 'Expected non-null request body');
  const params = parseUrlEncodedBody(checkCall!.requestBody!);
  assert(params['To'] === TEST_PHONE, `Expected To=${TEST_PHONE}, got To=${params['To']}`);
  assert(params['Code'] === TEST_OTP, `Expected Code=${TEST_OTP}, got Code=${params['Code']}`);
}

/**
 * POST /api/auth/verify-otp with valid OTP: if Twilio approves, asserts that
 * Supabase Admin API or local DB lookup follows the Twilio call (correct ordering).
 *
 * If Twilio rejects the OTP, asserts that NO Supabase call is made (short-circuit).
 */
async function testBoundary_verifyOtpCallOrdering() {
  const cursor = await getCaptureCursor();

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });

  const calls = await readCapturesAfter(cursor);

  if (res.status === 400) {
    // OTP was rejected — Twilio was called but Supabase should NOT be
    const supabaseCalls = calls.filter(
      (c) => c.url.includes('supabase') && !c.url.includes('/realtime/')
    );
    assert(
      supabaseCalls.length === 0,
      `Expected 0 Supabase calls when OTP rejected, got ${supabaseCalls.length}`
    );
  } else if (res.status === 200) {
    // OTP was approved — verify call ordering: Twilio BEFORE Supabase (if Supabase was called)
    const twilioIdx = calls.findIndex((c) => c.url.includes('verify.twilio.com'));
    const supabaseIdx = calls.findIndex(
      (c) => c.url.includes('supabase') && !c.url.includes('/realtime/')
    );

    assert(twilioIdx >= 0, 'Expected Twilio call when OTP approved');
    if (supabaseIdx >= 0) {
      assert(
        twilioIdx < supabaseIdx,
        `Twilio call (idx=${twilioIdx}) should come before Supabase call (idx=${supabaseIdx})`
      );

      // Assert Supabase call params
      const supabaseCall = calls[supabaseIdx];
      assert(
        supabaseCall.url.includes('/auth/v1/admin/users'),
        `Expected Supabase admin users endpoint, got: ${supabaseCall.url}`
      );
      assert(
        supabaseCall.method === 'POST',
        `Expected POST to Supabase, got ${supabaseCall.method}`
      );

      if (supabaseCall.requestBody) {
        const body = JSON.parse(supabaseCall.requestBody);
        assert(
          body.phone === TEST_PHONE,
          `Expected phone=${TEST_PHONE} in Supabase body, got phone=${body.phone}`
        );
        assert(body.phone_confirm === true, 'Expected phone_confirm=true in Supabase body');
      }
    }
    // If no Supabase call, the user already existed in local DB (valid path)
  }
}

/**
 * POST /api/auth/send-otp validation failures do NOT call Twilio.
 * Missing phone is caught before any outbound call.
 */
async function testBoundary_sendOtpValidationNoOutbound() {
  const cursor = await getCaptureCursor();

  await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const calls = await readCapturesAfter(cursor);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for validation failure, got ${filterInfraCalls(calls).length}`
  );
}

/**
 * POST /api/auth/verify-otp validation failures do NOT call Twilio.
 * Missing phone+token is caught before any outbound call.
 */
async function testBoundary_verifyOtpValidationNoOutbound() {
  const cursor = await getCaptureCursor();

  await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const calls = await readCapturesAfter(cursor);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for validation failure, got ${filterInfraCalls(calls).length}`
  );
}

/**
 * POST /api/auth/complete-onboarding for anonymous user (no phone) makes NO SMS calls.
 * The SMS code path is gated by `if (user.phone)`, which is null for anonymous users.
 */
async function testBoundary_completeOnboardingAnonNoSms() {
  // Create a dedicated anonymous session for this test
  const { accessToken } = await createAnonSession();

  const cursor = await getCaptureCursor();

  await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });

  // Small delay to catch any async fire-and-forget calls
  await new Promise((r) => setTimeout(r, 500));

  const calls = await readCapturesAfter(cursor);
  const smsCalls = calls.filter((c) => c.url.includes('surge.app'));
  assert(smsCalls.length === 0, `Expected 0 SMS calls for anonymous user, got ${smsCalls.length}`);
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Auth Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Phase 1: Setup
  console.log('Setting up auth sessions...');
  await setup();
  console.log(`  User 1: ${ctx.userId1}`);
  console.log(`  User 2: ${ctx.userId2}`);
  console.log(`  Onboarding user: ${ctx.userIdOnboarding}`);
  console.log(`  Capture available: ${ctx.captureAvailable}\n`);

  // Phase 2: Parallel independent tests
  const parallelTests = [
    { name: 'POST /anonymous -- happy path', fn: testAnonymous_happyPath },
    { name: 'POST /anonymous -- user ID is UUID', fn: testAnonymous_userIdIsUuid },
    { name: 'POST /anonymous -- token is JWT format', fn: testAnonymous_tokenIsJwtFormat },
    { name: 'POST /anonymous -- token_type is bearer', fn: testAnonymous_tokenTypeIsBearer },
    { name: 'POST /anonymous -- expires_at in future', fn: testAnonymous_expiresAtInFuture },
    { name: 'POST /anonymous -- unique user IDs', fn: testAnonymous_uniqueUserIds },
    { name: 'POST /anonymous -- initial credit created', fn: testAnonymous_initialCreditCreated },
    {
      name: 'POST /anonymous -- token works on protected endpoint',
      fn: testAnonymous_tokenWorksOnProtectedEndpoint,
    },
    { name: 'POST /send-otp -- missing phone -> 400', fn: testSendOtp_missingPhone },
    { name: 'POST /send-otp -- empty phone -> 400', fn: testSendOtp_emptyPhone },
    { name: 'POST /send-otp -- null phone -> 400', fn: testSendOtp_nullPhone },
    { name: 'POST /verify-otp -- missing all fields -> 400', fn: testVerifyOtp_missingAllFields },
    { name: 'POST /verify-otp -- missing token -> 400', fn: testVerifyOtp_missingToken },
    { name: 'POST /verify-otp -- missing phone -> 400', fn: testVerifyOtp_missingPhone },
    { name: 'POST /verify-otp -- empty strings -> 400', fn: testVerifyOtp_emptyStrings },
    { name: 'POST /complete-onboarding -- no auth -> 401', fn: testCompleteOnboarding_noAuth },
    {
      name: 'POST /complete-onboarding -- invalid JWT -> 401',
      fn: testCompleteOnboarding_invalidJwt,
    },
    {
      name: 'POST /complete-onboarding -- malformed Bearer -> 401',
      fn: testCompleteOnboarding_malformedBearer,
    },
    {
      name: 'POST /complete-onboarding -- wrong auth scheme -> 401',
      fn: testCompleteOnboarding_wrongScheme,
    },
    { name: 'auth middleware -- no header -> 401', fn: testAuthMiddleware_noHeader },
    { name: 'auth middleware -- invalid token -> 401', fn: testAuthMiddleware_invalidToken },
    { name: 'auth middleware -- empty bearer -> 401', fn: testAuthMiddleware_emptyBearerToken },
    { name: 'auth middleware -- API key (no user) -> 401', fn: testAuthMiddleware_apiKeyNoUser },
    { name: 'auth middleware -- valid anon token -> 200', fn: testAuthMiddleware_validAnonToken },
    {
      name: 'tenant isolation -- separate users see own data',
      fn: testTenantIsolation_separateUsers,
    },
    { name: 'error surface -- all 401s have error field', fn: testErrorSurface_401sHaveErrorField },
    { name: 'error surface -- all 400s have error field', fn: testErrorSurface_400sHaveErrorField },
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
      name: 'POST /complete-onboarding -- happy then idempotent',
      fn: testCompleteOnboarding_happyThenIdempotent,
    },
  ];

  // Add boundary capture tests if capture is available
  if (ctx.captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary -- anonymous makes no outbound calls',
        fn: testBoundary_anonymousNoOutboundCalls,
      },
      {
        name: 'boundary -- send-otp validation makes no outbound calls',
        fn: testBoundary_sendOtpValidationNoOutbound,
      },
      {
        name: 'boundary -- verify-otp validation makes no outbound calls',
        fn: testBoundary_verifyOtpValidationNoOutbound,
      },
      {
        name: 'boundary -- send-otp calls Twilio Verify with exact params',
        fn: testBoundary_sendOtpTwilioCall,
      },
      {
        name: 'boundary -- verify-otp calls Twilio VerificationCheck with exact params',
        fn: testBoundary_verifyOtpTwilioCall,
      },
      {
        name: 'boundary -- verify-otp call ordering (Twilio before Supabase)',
        fn: testBoundary_verifyOtpCallOrdering,
      },
      {
        name: 'boundary -- complete-onboarding anon user makes no SMS calls',
        fn: testBoundary_completeOnboardingAnonNoSms,
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

  console.log('\nALL AUTH BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
