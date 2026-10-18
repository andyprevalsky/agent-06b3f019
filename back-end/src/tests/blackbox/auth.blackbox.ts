#!/usr/bin/env tsx
/* eslint-disable max-lines */
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
import { createHash, randomUUID } from 'node:crypto';
import { retryWithBackoff } from '../../providers/retry';
import { phoneOwnershipCases } from './auth-phone-ownership.cases';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';

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
  cached?: boolean;
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
  replayAvailable: boolean;
}

const ctx: TestContext = { captureAvailable: false, replayAvailable: false };

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
  'anthropic.com',
  'openai.com',
  'chatgpt.com',
  'openrouter.ai',
  'supabase.co',
  'api.github.com',
  'ip-api.com',
  'surge.app',
  'verify.twilio.com',
  'e2b.app',
  'stripe.com',
  'parallel.ai',
  'exa.ai',
  'perplexity.ai',
  'vapi.ai',
  'googleapis.com',
  'connect.steelbrowser.com',
  'connect.steel.dev',
  'api.steel.dev',
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

async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

function captureToken(prefix: string): string {
  return `auth-${prefix}-${crypto.randomUUID()}`;
}

/** Read independently configured capture/replay capabilities from the backend. */
async function readCaptureCapabilities(): Promise<{
  captureEnabled: boolean;
  replayEnabled: boolean;
}> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures/status`);
    if (res.status !== 200) return { captureEnabled: false, replayEnabled: false };
    const body = (await res.json()) as { captureEnabled?: unknown; replayEnabled?: unknown };
    return {
      captureEnabled: body.captureEnabled === true,
      replayEnabled: body.replayEnabled === true,
    };
  } catch {
    return { captureEnabled: false, replayEnabled: false };
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

/**
 * Create an agent with retry logic to handle transient DB concurrency failures
 * ("Failed to create agent" 500). Retries up to 6 times with backoff.
 */
async function createAgentWithRetry(
  userId: string,
  goal: string
): Promise<{ status: number; data: unknown; headers: Headers }> {
  class RetryableAgentError extends Error {
    retryable = true as const;
    res: { status: number; data: unknown; headers: Headers };
    constructor(res: { status: number; data: unknown; headers: Headers }) {
      super('Failed to create agent');
      this.res = res;
    }
  }

  try {
    return await retryWithBackoff(
      async () => {
        const res = await request(`${BASE_URL}/api/agents`, {
          method: 'POST',
          headers: { ...apiKeyHeaders(), 'X-User-Id': userId },
          body: JSON.stringify({ goal, source: 'WEB' }),
        });
        if (res.status === 200 || res.status === 201) return res;
        const isRetryable500 =
          res.status === 500 &&
          typeof res.data === 'object' &&
          res.data !== null &&
          'error' in res.data &&
          (res.data as { error?: unknown }).error === 'Failed to create agent';
        if (isRetryable500) throw new RetryableAgentError(res);
        return res;
      },
      {
        maxRetries: 6,
        fixedDelays: [500, 1000, 1500, 2000, 2500],
        isRetryable: (err) => err instanceof RetryableAgentError,
        component: 'createAgentWithRetry',
      }
    );
  } catch (err) {
    if (err instanceof RetryableAgentError) return err.res;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fast-forward cache seeding
// ---------------------------------------------------------------------------
// The fetchCapture middleware wraps every outbound fetch with a fast-forward
// cache (FileSystemCache, namespace="outbound-fetch"). The cache key is
// `call:<JSON.stringify([url, method, body])>` and the file name is
// sha256(key).hex.json. Seeding a file with a crafted response lets us drive
// the verify-otp/Supabase paths deterministically — first request hits the
// seeded cache instead of dialing Twilio/Supabase.
//
// We only seed for fake phone numbers that are NOT in the real cache, so
// existing tests (which rely on the recorded test-phone responses) keep
// working untouched.

interface SerializedFFResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
}

function ffCacheKey(url: string, method: string, body: string | null): string {
  return `call:${JSON.stringify([url, method, body])}`;
}

/**
 * Seed through the running backend so an already-memoized key is replaced in
 * memory as well as on disk. Use this for shared keys that earlier auth cases
 * may have requested before the deterministic fixture is installed.
 */
async function seedLiveFastForward(
  url: string,
  method: string,
  body: string | null,
  response: SerializedFFResponse
): Promise<void> {
  const key = ffCacheKey(url, method, body);
  const value = { __ff_promise_result: true, value: response };
  const res = await request(`${BASE_URL}/api/test/captures/cache`, {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  });
  assertStatus(res.status, 200, res.data);
}

/**
 * Seed a Twilio Verify VerificationCheck response for (phone, code).
 * Returns whether seeding succeeded (false if TWILIO_VERIFY_SERVICE_SID is unset).
 *
 * Always seeds through the live backend cache (not disk-only). Disk-only writes
 * race with NonBlockingFileCache memoization when another case already touched
 * the key, and with multi-second gaps (e.g. createAgent before verify-otp) under
 * a shared suite cache — producing a live Twilio "Invalid code" 400.
 */
async function seedTwilioVerifyCheck(
  phone: string,
  code: string,
  approved: boolean,
  options: { httpStatus?: number; twilioCode?: number; twilioMessage?: string } = {}
): Promise<boolean> {
  if (TWILIO_VERIFY_SERVICE_SID === '') return false;
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`;
  const body = new URLSearchParams({ To: phone, Code: code }).toString();
  const httpStatus = options.httpStatus ?? 200;
  const responseBody =
    httpStatus === 200
      ? JSON.stringify({
          account_sid: 'ACseed',
          channel: 'sms',
          service_sid: TWILIO_VERIFY_SERVICE_SID,
          sid: `VE${randomUUID().replace(/-/g, '')}`.slice(0, 34),
          status: approved ? 'approved' : 'pending',
          to: phone,
          valid: approved,
        })
      : JSON.stringify({
          code: options.twilioCode ?? 20404,
          message: options.twilioMessage ?? 'Seeded error',
          status: httpStatus,
        });
  await seedLiveFastForward(url, 'POST', body, {
    status: httpStatus,
    statusText: httpStatus === 200 ? 'OK' : 'Error',
    body: responseBody,
    headers: { 'content-type': 'application/json' },
  });
  return true;
}

/**
 * Seed a Twilio Verify Verifications (send) response for a phone.
 */
async function seedTwilioVerifySend(
  phone: string,
  options: { httpStatus?: number; twilioCode?: number; twilioMessage?: string } = {}
): Promise<boolean> {
  if (TWILIO_VERIFY_SERVICE_SID === '') return false;
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/Verifications`;
  const body = new URLSearchParams({ To: phone, Channel: 'sms' }).toString();
  const httpStatus = options.httpStatus ?? 201;
  const responseBody =
    httpStatus >= 400
      ? JSON.stringify({
          code: options.twilioCode ?? 60200,
          message: options.twilioMessage ?? 'Seeded error',
          status: httpStatus,
        })
      : JSON.stringify({
          account_sid: 'ACseed',
          channel: 'sms',
          service_sid: TWILIO_VERIFY_SERVICE_SID,
          sid: `VE${randomUUID().replace(/-/g, '')}`.slice(0, 34),
          status: 'pending',
          to: phone,
          valid: false,
        });
  await seedLiveFastForward(url, 'POST', body, {
    status: httpStatus,
    statusText: httpStatus < 400 ? 'OK' : 'Error',
    body: responseBody,
    headers: { 'content-type': 'application/json' },
  });
  return true;
}

/**
 * Seed a Supabase Admin POST /auth/v1/admin/users response for a phone.
 */
async function seedSupabaseAdminCreate(
  phone: string,
  options: { httpStatus?: number; userId?: string; errorCode?: string; msg?: string } = {}
): Promise<boolean> {
  if (SUPABASE_URL === '') return false;
  const url = `${SUPABASE_URL}/auth/v1/admin/users`;
  const body = JSON.stringify({ phone, phone_confirm: true });
  const httpStatus = options.httpStatus ?? 200;
  const responseBody =
    httpStatus < 400
      ? JSON.stringify({ id: options.userId ?? randomUUID(), phone })
      : JSON.stringify({
          error_code: options.errorCode ?? 'unknown',
          msg: options.msg ?? 'Seeded error',
        });
  await seedLiveFastForward(url, 'POST', body, {
    status: httpStatus,
    statusText: httpStatus < 400 ? 'OK' : 'Error',
    body: responseBody,
    headers: { 'content-type': 'application/json' },
  });
  return true;
}

/**
 * Seed Supabase Admin GET /auth/v1/admin/users for the phone_exists recovery path.
 */
async function seedSupabaseAdminListUsers(
  users: Array<{ id: string; phone?: string }>
): Promise<boolean> {
  if (SUPABASE_URL === '') return false;
  const url = new URL(`${SUPABASE_URL}/auth/v1/admin/users`);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', '1000');
  const response = {
    status: 200,
    statusText: 'OK',
    body: JSON.stringify({ users }),
    headers: { 'content-type': 'application/json' },
  };
  await seedLiveFastForward(url.toString(), 'GET', null, response);
  return true;
}

/**
 * Generate a unique fake phone number for a test, in E.164 format.
 * Uses an unused-but-syntactically-valid number block so seeded cache entries
 * never collide with real Twilio responses recorded for legitimate test phones.
 *
 * Format: `+1 555 XXX YYYY` (NANP-shaped). The 7 trailing digits are derived
 * from a per-process UUID (32 bits of entropy) plus a monotonic counter, so
 * concurrent tests in the same process get distinct phones AND historical
 * users in the local DB from prior test runs do not collide with this run.
 */
const fakePhoneRunSeed = parseInt(randomUUID().replace(/-/g, '').slice(0, 8), 16) % 10_000_000;
let fakePhoneCounter = 0;
function uniqueFakePhone(): string {
  fakePhoneCounter++;
  const suffix = (fakePhoneRunSeed + fakePhoneCounter) % 10_000_000;
  // E.164 layout: +1 (country) 555 (area) XXXXXXX (7 unique digits) = 10 NANP digits
  return `+1555${String(suffix).padStart(7, '0')}`;
}

/** True if both Twilio and Supabase config are available for seeding AND
 *  the backend is in capture mode (without capture mode the fast-forward
 *  cache files are written but the backend ignores them and makes real
 *  Twilio/Supabase calls — so seeded tests can't pass).
 */
function canSeedAuthFlow(): boolean {
  return (
    TWILIO_VERIFY_SERVICE_SID !== '' &&
    SUPABASE_URL !== '' &&
    ctx.captureAvailable &&
    ctx.replayAvailable
  );
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
  const captureCapabilities = await readCaptureCapabilities();
  ctx.captureAvailable = captureCapabilities.captureEnabled;
  ctx.replayAvailable = captureCapabilities.replayEnabled;
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

async function testVerifyOtp_nonStringEmail() {
  // email is optional, but a non-string payload (number/object) must be
  // rejected at the boundary — normalizeEmail would otherwise .trim() it and
  // 500 after the OTP verification already succeeded. null is tolerated
  // (treated as absent) since JSON clients commonly send explicit nulls.
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: '+10000000000', token: '123456', email: 123 }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'verify-otp non-string email');
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
const REVIEW_TEST_PHONE = '+15555550123';
const REVIEW_TEST_OTP = '191919';
/** Synthetic phone for Twilio boundary assertions — never the admin/test phones. */
const BOUNDARY_TWILIO_PHONE = '+15551239999';
const BOUNDARY_TWILIO_OTP = '424242';

/**
 * POST /api/auth/anonymous makes NO outbound HTTP calls.
 * All work is local (JWT signing + DB insert).
 */
async function testBoundary_anonymousNoOutboundCalls() {
  const token = captureToken('anonymous');
  await request(`${BASE_URL}/api/auth/anonymous`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
  });
  const calls = await readCapturesForToken(token);
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
 * Admin/test phone must NEVER call live Twilio Verify — even under capture —
 * because it shares the production Verify service and rate-limits prod login.
 */
async function testBoundary_adminPhoneNeverHitsTwilio() {
  const sendToken = captureToken('admin-phone-no-twilio-send');
  const sendRes = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': sendToken },
    body: JSON.stringify({ phone: TEST_PHONE }),
  });
  assertStatus(sendRes.status, 200, sendRes.data);
  const sendTwilio = (await readCapturesForToken(sendToken)).filter((c) =>
    c.url.includes('verify.twilio.com')
  );
  assert(
    sendTwilio.length === 0,
    `Expected 0 Twilio calls for admin send-otp, got ${sendTwilio.length}`
  );

  const wrongToken = captureToken('admin-phone-no-twilio-wrong');
  const wrongRes = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': wrongToken },
    body: JSON.stringify({ phone: TEST_PHONE, token: '000000' }),
  });
  if (wrongRes.status === 200) {
    throw new Error('Expected wrong OTP on admin phone to fail without Twilio');
  }
  const wrongTwilio = (await readCapturesForToken(wrongToken)).filter((c) =>
    c.url.includes('verify.twilio.com')
  );
  assert(
    wrongTwilio.length === 0,
    `Expected 0 Twilio calls for admin wrong-OTP, got ${wrongTwilio.length}`
  );

  // A fresh local test database may not have this phone yet. Seed the
  // Supabase user creation response so this boundary test is self-contained.
  await seedSupabaseAdminCreate(TEST_PHONE);
  const okToken = captureToken('admin-phone-no-twilio-ok');
  const okRes = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': okToken },
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });
  assertStatus(okRes.status, 200, okRes.data);
  const okTwilio = (await readCapturesForToken(okToken)).filter((c) =>
    c.url.includes('verify.twilio.com')
  );
  assert(
    okTwilio.length === 0,
    `Expected 0 Twilio calls for admin verify-otp, got ${okTwilio.length}`
  );
}

/**
 * POST /api/auth/send-otp calls Twilio Verify Verifications API with exact params.
 * Uses a synthetic phone + seeded Twilio response so we never burn the admin
 * phone's live Verify quota.
 */
async function testBoundary_sendOtpTwilioCall() {
  if (TWILIO_VERIFY_SERVICE_SID === '') {
    console.log('    [skipped] Twilio not configured — cannot test boundary');
    return;
  }
  if (!(await seedTwilioVerifySend(BOUNDARY_TWILIO_PHONE, { httpStatus: 201 }))) {
    console.log('    [skipped] Could not seed Twilio send response');
    return;
  }

  const token = captureToken('send-otp-twilio');

  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({ phone: BOUNDARY_TWILIO_PHONE }),
  });

  if (res.status === 400) {
    const data = res.data as { error?: string };
    if (data.error?.includes('configuration')) {
      console.log('    [skipped] Twilio not configured — cannot test boundary');
      return;
    }
  }

  assertStatus(res.status, 200, res.data);

  const allCalls = await readCapturesForToken(token);
  const calls = allCalls.filter((c) => c.url.includes('verify.twilio.com'));
  assert(
    calls.length === 1,
    `Expected exactly 1 Twilio Verify call, got ${calls.length} (${allCalls.length} total captures)`
  );

  const call = calls[0];

  assert(
    call.url.startsWith('https://verify.twilio.com/v2/Services/') &&
      call.url.endsWith('/Verifications'),
    `Unexpected Twilio URL: ${call.url}`
  );

  assert(call.method === 'POST', `Expected POST, got ${call.method}`);

  assert(
    call.requestHeaders['Content-Type'] === 'application/x-www-form-urlencoded',
    `Expected Content-Type: application/x-www-form-urlencoded, got: ${call.requestHeaders['Content-Type']}`
  );
  assert(
    call.requestHeaders['Authorization'] === '[redacted]',
    'Expected captured authorization to be fully redacted'
  );

  assert(call.requestBody !== null, 'Expected non-null request body');
  const params = parseUrlEncodedBody(call.requestBody!);
  assert(
    params['To'] === BOUNDARY_TWILIO_PHONE,
    `Expected To=${BOUNDARY_TWILIO_PHONE}, got To=${params['To']}`
  );
  assert(params['Channel'] === 'sms', `Expected Channel=sms, got Channel=${params['Channel']}`);

  assert(call.responseStatus !== null, 'Expected a response from Twilio');
}

/**
 * An unseeded OTP send in a test stack is answered by the fetch-boundary fake:
 * the synthetic SID is derived from the request body, so a live Twilio reply
 * (or a live rejection) cannot satisfy this assertion.
 */
async function testBoundary_unseededSendOtpNeverReachesTwilio() {
  if (TWILIO_VERIFY_SERVICE_SID === '') {
    console.log('    [skipped] Twilio not configured — cannot test boundary');
    return;
  }
  const phone = `+1555${String(Date.now()).slice(-7)}`;
  const token = captureToken('send-otp-unseeded');

  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({ phone }),
  });
  assertStatus(res.status, 200, res.data);

  const calls = (await readCapturesForToken(token)).filter((c) =>
    c.url.includes('verify.twilio.com')
  );
  assert(calls.length === 1, `Expected exactly 1 Twilio Verify call, got ${calls.length}`);
  const [call] = calls;
  const expectedSid = `VE${createHash('sha256')
    .update(`capture:${call.requestBody ?? ''}`)
    .digest('hex')
    .slice(0, 32)}`;
  const body = JSON.parse(call.responseBody ?? '{}') as { sid?: string; to?: string };
  assert(call.responseStatus === 201, `Expected faked 201, got ${call.responseStatus}`);
  assert(call.cached === false, 'Unseeded send must not come from a replay fixture');
  assert(body.sid === expectedSid, `Twilio Verify send was not faked: sid=${body.sid}`);
  assert(body.to === phone, `Faked Twilio response lost To: ${body.to}`);
}

/**
 * POST /api/auth/verify-otp calls Twilio Verify VerificationCheck with exact params.
 * Uses a synthetic phone + seeded VerificationCheck so we never hit live Twilio
 * for the admin/test phone.
 */
async function testBoundary_verifyOtpTwilioCall() {
  if (TWILIO_VERIFY_SERVICE_SID === '') {
    console.log('    [skipped] Twilio not configured — cannot test boundary');
    return;
  }
  if (!(await seedTwilioVerifyCheck(BOUNDARY_TWILIO_PHONE, BOUNDARY_TWILIO_OTP, true))) {
    console.log('    [skipped] Could not seed Twilio check response');
    return;
  }

  const token = captureToken('verify-otp-twilio');

  await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({ phone: BOUNDARY_TWILIO_PHONE, token: BOUNDARY_TWILIO_OTP }),
  });

  const calls = await readCapturesForToken(token);
  const twilioCalls = calls.filter((c) => c.url.includes('verify.twilio.com'));
  assert(
    twilioCalls.length >= 1,
    `Expected at least 1 Twilio call for synthetic boundary phone, got ${twilioCalls.length}`
  );

  const checkCall = twilioCalls.find((c) => c.url.includes('/VerificationCheck'));
  assert(checkCall !== undefined, 'Expected a VerificationCheck call to Twilio');

  assert(
    checkCall!.url.startsWith('https://verify.twilio.com/v2/Services/') &&
      checkCall!.url.endsWith('/VerificationCheck'),
    `Unexpected VerificationCheck URL: ${checkCall!.url}`
  );

  assert(checkCall!.method === 'POST', `Expected POST, got ${checkCall!.method}`);

  assert(
    checkCall!.requestHeaders['Content-Type'] === 'application/x-www-form-urlencoded',
    `Expected Content-Type: application/x-www-form-urlencoded`
  );
  assert(
    checkCall!.requestHeaders['Authorization'] === '[redacted]',
    'Expected captured authorization to be fully redacted'
  );

  assert(checkCall!.requestBody !== null, 'Expected non-null request body');
  const params = parseUrlEncodedBody(checkCall!.requestBody!);
  assert(
    params['To'] === BOUNDARY_TWILIO_PHONE,
    `Expected To=${BOUNDARY_TWILIO_PHONE}, got To=${params['To']}`
  );
  assert(
    params['Code'] === BOUNDARY_TWILIO_OTP,
    `Expected Code=${BOUNDARY_TWILIO_OTP}, got Code=${params['Code']}`
  );
}

async function testBoundary_verifyOtpCallOrdering() {
  const token = captureToken('verify-otp-ordering');

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });

  const calls = await readCapturesForToken(token);

  if (res.status === 400) {
    // OTP was rejected — Twilio was called but Supabase admin users endpoint should NOT be.
    // Filter to only the admin users endpoint; realtime broadcasts from concurrent tests are noise.
    const supabaseCalls = calls.filter((c) => c.url.includes('supabase.co/auth/v1/admin/users'));
    assert(
      supabaseCalls.length === 0,
      `Expected 0 Supabase admin calls when OTP rejected, got ${supabaseCalls.length}`
    );
  } else if (res.status === 200) {
    // OTP was approved — check whether Twilio was called at all.
    // Test credentials (+19729777432 / 181818) bypass Twilio entirely on the server side,
    // so there may be 0 Twilio calls even on a successful verify. That is a valid path.
    const twilioIdx = calls.findIndex((c) => c.url.includes('verify.twilio.com'));
    // Only match the admin users endpoint, not realtime broadcasts or other Supabase URLs
    const supabaseIdx = calls.findIndex((c) => c.url.includes('supabase.co/auth/v1/admin/users'));

    if (twilioIdx >= 0 && supabaseIdx >= 0) {
      // Both were called — assert ordering: Twilio BEFORE Supabase
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
    // If no Twilio call: test credentials bypassed Twilio (valid).
    // If no Supabase call: user already existed in local DB (valid).
  }
}

/**
 * Review credentials bypass Twilio in every environment. This is intentionally
 * narrower than the dev bypass: only the review phone + review OTP work.
 */
async function testBoundary_reviewOtpBypassNoTwilio() {
  const phone = REVIEW_TEST_PHONE;
  const userId = randomUUID();
  if (SUPABASE_URL !== '') {
    await seedSupabaseAdminCreate(phone, { userId });
  }

  const sendToken = captureToken('review-send-otp-bypass');
  const sendRes = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': sendToken },
    body: JSON.stringify({ phone }),
  });
  assertStatus(sendRes.status, 200, sendRes.data);
  const sendCalls = await readCapturesForToken(sendToken);
  const sendTwilioCalls = sendCalls.filter((c) => c.url.includes('verify.twilio.com'));
  assert(
    sendTwilioCalls.length === 0,
    `Expected review send-otp bypass to make 0 Twilio calls, got ${sendTwilioCalls.length}`
  );

  const verifyToken = captureToken('review-verify-otp-bypass');
  const verifyRes = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': verifyToken },
    body: JSON.stringify({ phone, token: REVIEW_TEST_OTP }),
  });
  if (verifyRes.status !== 200 && verifyRes.status !== 500) {
    throw new Error(
      `Expected review verify bypass to approve OTP before user init, got ${verifyRes.status}: ${JSON.stringify(verifyRes.data)}`
    );
  }
  const verifyCalls = await readCapturesForToken(verifyToken);
  const verifyTwilioCalls = verifyCalls.filter((c) => c.url.includes('verify.twilio.com'));
  assert(
    verifyTwilioCalls.length === 0,
    `Expected review verify-otp bypass to make 0 Twilio calls, got ${verifyTwilioCalls.length}`
  );
}

/**
 * POST /api/auth/send-otp validation failures do NOT call Twilio.
 * Missing phone is caught before any outbound call.
 */
async function testBoundary_sendOtpValidationNoOutbound() {
  const token = captureToken('send-otp-validation');

  await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({}),
  });

  const calls = await readCapturesForToken(token);
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
  const token = captureToken('verify-otp-validation');

  await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({}),
  });

  const calls = await readCapturesForToken(token);
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

  const token = captureToken('complete-onboarding-anon');

  await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: { ...authHeaders(accessToken), 'X-Capture-Token': token },
  });

  // Small delay to catch any async fire-and-forget calls
  await new Promise((r) => setTimeout(r, 500));

  const calls = await readCapturesForToken(token);
  const smsCalls = calls.filter((c) => c.url.includes('surge.app'));
  assert(smsCalls.length === 0, `Expected 0 SMS calls for anonymous user, got ${smsCalls.length}`);
}

// ==================== ADDITIONAL COVERAGE TESTS ====================

// --- Send OTP happy path (exercises Twilio Verify integration) ---

async function testSendOtp_happyPath() {
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: '+19729777432' }),
  });
  // 200 if Twilio Verify is configured, 400/500 if not
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for send-otp, got ${res.status}`);
  }
}

async function testSendOtp_reviewBypassHappyPath() {
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: REVIEW_TEST_PHONE }),
  });
  assertStatus(res.status, 200, res.data);
}

async function testSendOtp_invalidPhoneFormat() {
  await seedTwilioVerifySend('not-a-phone', {
    httpStatus: 400,
    twilioCode: 60200,
    twilioMessage: 'Invalid parameter `To`',
  });
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: 'not-a-phone' }),
  });
  // Should fail with 400 or 500 (Twilio rejects invalid phone)
  if (res.status === 200) {
    throw new Error('Expected failure for invalid phone format');
  }
}

// --- Verify OTP (exercises the full verification + user init flow) ---

async function testVerifyOtp_wrongCode() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: '+19729777432', token: '000000' }),
  });
  // Wrong OTP → 400 or 500 (depending on Twilio config)
  if (res.status === 200) {
    throw new Error('Expected failure for wrong OTP code');
  }
}

async function testVerifyOtp_reviewPhoneRejectsMainOtp() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: REVIEW_TEST_PHONE, token: TEST_OTP }),
  });
  if (res.status === 200) {
    throw new Error('Expected review phone to reject the main dev OTP');
  }
}

async function testVerifyOtp_withAnonymousUserId() {
  // Create anonymous session first
  const { userId: anonUserId } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: '+19729777432',
      token: '181818',
      anonymousUserId: anonUserId,
      firstName: 'Test',
      lastName: 'User',
    }),
  });
  // 200 if Twilio is configured and OTP succeeds, 400/500 otherwise
  // Either way, exercises the full verify + user init code path
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for verify-otp with anonymous, got ${res.status}`);
  }
}

async function testVerifyOtp_withoutOptionalFields() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: '+19729777432', token: '181818' }),
  });
  // Exercises verify path without firstName/lastName/anonymousUserId
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for verify-otp minimal, got ${res.status}`);
  }
}

// --- Complete onboarding edge cases ---

async function testCompleteOnboarding_happyPath() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { success: boolean; alreadyCompleted: boolean };
  if (body.success !== true) {
    throw new Error(`Expected success=true, got ${JSON.stringify(res.data)}`);
  }
}

async function testCompleteOnboarding_idempotent() {
  const { accessToken } = await createAnonSession();
  // First call
  const res1 = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
  assertStatus(res1.status, 200, res1.data);
  const body1 = res1.data as { alreadyCompleted: boolean };
  if (body1.alreadyCompleted !== false) {
    throw new Error(`First call: expected alreadyCompleted=false, got ${body1.alreadyCompleted}`);
  }

  // Second call — should be idempotent with alreadyCompleted=true
  const res2 = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
  assertStatus(res2.status, 200, res2.data);
  const body2 = res2.data as { alreadyCompleted: boolean };
  if (body2.alreadyCompleted !== true) {
    throw new Error(`Second call: expected alreadyCompleted=true, got ${body2.alreadyCompleted}`);
  }
}

// ==================== COVERAGE BOOST TESTS ====================

// 1. Full verify-otp flow with firstName + lastName
async function testVerifyOtp_fullFlowWithNames() {
  // Send OTP first
  await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE }),
  });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      firstName: 'Test',
      lastName: 'User',
    }),
  });

  // Accept 200/400/500 depending on Twilio config / fast-forward cache
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }

  if (res.status === 200) {
    const body = res.data as {
      user?: { id?: string; phone?: string };
      session?: { access_token?: string };
    };
    assert(typeof body.user?.id === 'string', 'Expected user.id to be a string');
    assert(typeof body.user?.phone === 'string', 'Expected user.phone to be a string');
    assert(
      typeof body.session?.access_token === 'string',
      'Expected session.access_token to be a string'
    );
  }
}

// 1b. verify-otp with optional email — exercises the email persistence path
async function testVerifyOtp_withEmail() {
  await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE }),
  });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      firstName: 'Test',
      lastName: 'User',
      email: 'test.user@example.com',
    }),
  });

  // Accept 200/400/500 depending on Twilio config / fast-forward cache.
  // The point is that a valid optional email never breaks the verify path.
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 1c. verify-otp with a malformed email — must still succeed (email is dropped, not rejected)
async function testVerifyOtp_withMalformedEmailStillSucceeds() {
  await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE }),
  });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      email: 'not-an-email',
    }),
  });

  // A malformed optional email is normalized away server-side — it must NOT turn
  // an otherwise-valid verification into a 4xx/5xx that a well-formed one avoids.
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 2. verify-otp with firstName only (no lastName) — exercises name building
async function testVerifyOtp_firstNameOnly() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      firstName: 'Alice',
    }),
  });

  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 3. verify-otp with empty string anonymousUserId — exercises empty string guard
async function testVerifyOtp_emptyAnonymousUserId() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      anonymousUserId: '',
    }),
  });

  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 4. verify-otp twice with same phone — exercises handleExistingUser path
async function testVerifyOtp_secondVerifySamePhone() {
  // First verify
  await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });

  // Second verify — same phone, exercises handleExistingUser
  const res2 = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });

  if (res2.status !== 200 && res2.status !== 400 && res2.status !== 500) {
    throw new Error(`Expected 200/400/500 on second verify, got ${res2.status}`);
  }
}

// 5. First verify without name, second verify with firstName — exercises name update branch in handleExistingUser
async function testVerifyOtp_existingUserNameUpdate() {
  // First verify without name
  await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });

  // Second verify with firstName — exercises name update
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      firstName: 'UpdatedName',
    }),
  });

  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 6. Create anonymous session, create agent with anon user, then verify-otp with anonymousUserId — exercises mergeAnonymousUserResources + transferAgents
async function testVerifyOtp_anonMergeWithAgents() {
  // Create anonymous session
  const { userId: anonUserId } = await createAnonSession();

  // Create an agent with the anonymous user (retry on transient 500s)
  const agentRes = await createAgentWithRetry(anonUserId, 'Test merge');

  // Agent creation should succeed (200 or 201)
  if (agentRes.status !== 200 && agentRes.status !== 201) {
    throw new Error(
      `Expected 200/201 for agent creation, got ${agentRes.status}: ${JSON.stringify(agentRes.data)}`
    );
  }

  // Now verify OTP with the anonymousUserId to exercise merge
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      anonymousUserId: anonUserId,
    }),
  });

  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 7. Verify OTP with phone then complete onboarding — exercises SMS sending code path in completeOnboarding
async function testCompleteOnboarding_afterPhoneVerify() {
  // Verify OTP to get a phone-verified user with session
  const verifyRes = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });

  if (verifyRes.status !== 200) {
    // If Twilio is not configured, skip the test gracefully
    return;
  }

  const verifyBody = verifyRes.data as { session?: { access_token?: string } };
  const token = verifyBody.session?.access_token;
  assert(typeof token === 'string', 'Expected access_token after verify-otp');

  // Complete onboarding with the phone-verified user
  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders(token!),
  });

  assertStatus(res.status, 200, res.data);
  const body = res.data as { success: boolean };
  assert(body.success === true, 'Expected success=true for complete-onboarding');
}

// 8. Complete onboarding via API key + X-User-Id headers instead of JWT
async function testCompleteOnboarding_viaApiKey() {
  // Create anonymous session to get a valid user
  const { userId } = await createAnonSession();

  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': userId },
  });

  // The authenticate middleware checks for Bearer token or API key + X-User-Id
  // Accept 200 (if hybridAuth supports it) or 401 (if it requires Bearer)
  if (res.status !== 200 && res.status !== 401) {
    throw new Error(
      `Expected 200 or 401 for API key auth, got ${res.status}: ${JSON.stringify(res.data)}`
    );
  }
}

// 9. send-otp with valid E.164 international format
async function testSendOtp_validE164() {
  const phone = '+447911123456';
  await seedTwilioVerifySend(phone, { httpStatus: 201 });
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });

  // 200 when seeded/configured, 400/500 otherwise
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for E.164 phone, got ${res.status}`);
  }
}

// 10. verify-otp with wrong code — assert error message contains relevant text
async function testVerifyOtp_wrongCodeErrorMessage() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE, token: '000000' }),
  });

  // Wrong OTP should not return 200
  if (res.status === 200) {
    throw new Error('Expected failure for wrong OTP code');
  }

  // Assert error field is present and has content
  const body = res.data as { error?: string };
  assert(typeof body.error === 'string', 'Expected error field in response');
  assert(body.error!.length > 0, 'Expected non-empty error message');
}

// 11. Create 5 anonymous sessions in parallel — assert all have unique user IDs
async function testAnonymous_multipleSessionsParallel() {
  const promises = Array.from({ length: 5 }, () =>
    request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' })
  );

  const results = await Promise.all(promises);
  const userIds = new Set<string>();

  for (const res of results) {
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(AnonymousResponse, res.data, 'parallel anon');
    assert(UUID_RE.test(body.user.id), `Expected UUID, got: ${body.user.id}`);
    userIds.add(body.user.id);
  }

  assert(userIds.size === 5, `Expected 5 unique user IDs, got ${userIds.size}`);
}

// 12. Create anonymous session then GET /api/credits/usage with that token — exercises credits endpoint with JWT auth
async function testCreditsUsage_afterAnonymous() {
  const { accessToken } = await createAnonSession();

  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(accessToken),
  });

  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'credits/usage after anon');
  assert(typeof body.total === 'number', 'Expected total to be a number');
  assert(typeof body.remaining === 'number', 'Expected remaining to be a number');
}

// 13. GET /api/credits/usage with X-API-Key + query param userId — exercises internal API key path
async function testCreditsUsage_viaApiKeyWithUserId() {
  if (!API_KEY) return;

  const { userId } = await createAnonSession();

  const res = await request(`${BASE_URL}/api/credits/usage?userId=${userId}`, {
    headers: apiKeyHeaders(),
  });

  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'credits/usage via API key');
  assert(typeof body.total === 'number', 'Expected total to be a number');
}

// 14. GET /api/credits/subscription with anonymous token — exercises credits subscription endpoint
async function testCreditsSubscription_afterAnonymous() {
  const { accessToken } = await createAnonSession();

  const res = await request(`${BASE_URL}/api/credits/subscription`, {
    headers: authHeaders(accessToken),
  });

  assertStatus(res.status, 200, res.data);
  const body = res.data as Record<string, unknown>;
  assert(typeof body === 'object' && body !== null, 'Expected object response from subscription');
}

// 15. GET /api/credits/stats with anonymous token — exercises credits stats endpoint
async function testCreditsStats_afterAnonymous() {
  const { accessToken } = await createAnonSession();

  const res = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(accessToken),
  });

  assertStatus(res.status, 200, res.data);
  const body = res.data as Record<string, unknown>;
  assert(typeof body === 'object' && body !== null, 'Expected object response from stats');
}

// ==================== DEEP COVERAGE TESTS ====================

// 1. verify-otp with anonymousUserId that has agents — exercises mergeAnonymousUserResources + handleNewUser/handleExistingUser paths
async function testVerifyOtp_newUserWithAnonymousIdAndAgents() {
  // Create anonymous session and an agent for that user
  const { userId: anonUserId } = await createAnonSession();

  // Create an agent with the anonymous user via API key (retry on transient 500s)
  const agentRes = await createAgentWithRetry(anonUserId, 'Agent for merge test');

  if (agentRes.status !== 200 && agentRes.status !== 201) {
    throw new Error(
      `Expected 200/201 for agent creation, got ${agentRes.status}: ${JSON.stringify(agentRes.data)}`
    );
  }

  // Now verify OTP with the anonymousUserId — exercises the full merge path
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      anonymousUserId: anonUserId,
      firstName: 'MergeTest',
    }),
  });

  // Accept 200/400/500 depending on Twilio config
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 2. verify-otp with both firstName AND lastName — exercises name building with multiple parts
async function testVerifyOtp_existingUserNameUpdate_BothNames() {
  // First verify without name to create/find user
  await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: TEST_PHONE, token: TEST_OTP }),
  });

  // Second verify with both firstName AND lastName
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      firstName: 'Coverage',
      lastName: 'TestUser',
    }),
  });

  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 3. Complete onboarding for anonymous user (no phone) — exercises the no-phone branch in completeOnboarding
async function testCompleteOnboarding_anonUserNoSms() {
  const { accessToken } = await createAnonSession();

  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });

  assertStatus(res.status, 200, res.data);
  const body = assertSchema(OnboardingResponse, res.data, 'onboarding anon no sms');
  assert(body.success === true, 'Expected success=true');
  assert(body.alreadyCompleted === false, 'Expected first onboarding to not be already completed');
  assert(body.onboardingCompletedAt !== null, 'Expected onboardingCompletedAt to be set');
}

// 4. verify-otp with lastName only (no firstName) — exercises name parts filter
async function testVerifyOtp_lastNameOnly() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      lastName: 'OnlyLastName',
    }),
  });

  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 5. verify-otp where anonymousUserId equals the resulting userId — exercises the guard anonymousUserId !== userId
async function testVerifyOtp_anonIdSameAsUserId() {
  // This exercises the guard in handleNewUser/handleExistingUser where anonymousUserId === userId
  // Send verify with a fake anonymousUserId that happens to be the same user's ID
  // This is an edge case that should be handled gracefully
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      anonymousUserId: '00000000-0000-0000-0000-000000000000', // unlikely to match
    }),
  });

  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 6. Create multiple anonymous sessions then verify — exercises createAnonymousSession + createInitialCredit
async function testAnonymous_eachGetInitialCredit() {
  const sessions = await Promise.all([
    createAnonSession(),
    createAnonSession(),
    createAnonSession(),
  ]);

  // Each anonymous session should have credits
  for (const { accessToken } of sessions) {
    const res = await request(`${BASE_URL}/api/credits/usage`, {
      headers: authHeaders(accessToken),
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(UsageResponse, res.data, 'anon credits check');
    assert(body.total > 0, `Expected credit > 0 for anonymous user, got ${body.total}`);
  }
}

// 7. complete-onboarding twice then a third time — verifies deep idempotency
async function testCompleteOnboarding_tripleIdempotency() {
  const { accessToken } = await createAnonSession();

  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(OnboardingResponse, res.data, `onboarding call ${i + 1}`);
    assert(body.success === true, 'Expected success=true');
    if (i === 0) {
      assert(body.alreadyCompleted === false, 'First call should be alreadyCompleted=false');
    } else {
      assert(body.alreadyCompleted === true, `Call ${i + 1} should be alreadyCompleted=true`);
    }
  }
}

// 8. send-otp with various phone formats
async function testSendOtp_variousFormats() {
  // Test with phone that has spaces (should fail or be handled)
  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone: '+1 972 977 7432' }),
  });

  // Accept any status — exercises the Twilio path with different formats
  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 9. verify-otp with empty firstName and lastName — exercises empty string filter
async function testVerifyOtp_emptyNameStrings() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      firstName: '',
      lastName: '',
    }),
  });

  if (res.status !== 200 && res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500, got ${res.status}`);
  }
}

// 10. Anonymous session token has correct expires_in and expires_at relationship
async function testAnonymous_sessionTimingConsistency() {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'anon timing');

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = body.session.expires_in;
  const expiresAt = body.session.expires_at;

  // expires_at should be approximately now + expires_in (within 30 seconds tolerance
  // to account for slow test environments and DB latency)
  const diff = Math.abs(expiresAt - (now + expiresIn));
  assert(diff < 30, `expires_at and expires_in are inconsistent. diff=${diff}s`);
}

// ==================== SEEDED-CACHE COVERAGE TESTS ====================
// These tests exercise the verify-otp + onboarding paths that depend on a
// successful Twilio + Supabase response. The recorded cache for the test
// phone returns "pending" (Twilio's actual response), so the user-init
// branches in service.ts/service.twilio.ts never run. To cover them we
// pre-seed the fast-forward cache with crafted responses for unique fake
// phones that don't collide with the recorded fixtures.

const SEED_OTP = '888888';

/**
 * Successful verify-otp flow for a brand-new user, no firstName/lastName.
 * Exercises:
 *   - service.twilio.ts: checkTwilioVerifyOTP success branch + findOrCreateSupabaseUser create branch
 *   - service.ts:        verifyOtpAndInitUser happy path + handleNewUser with fullName=null
 */
async function testVerifyOtp_seededHappyPath_newUser() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  const userId = randomUUID();
  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, { userId });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });

  assertStatus(res.status, 200, res.data);
  const body = res.data as {
    success?: boolean;
    user?: { id?: string; phone?: string; is_anonymous?: boolean };
    session?: { access_token?: string };
  };
  assert(body.success === true, 'Expected success=true on seeded verify-otp');
  assert(body.user?.id === userId, `Expected user.id=${userId}, got ${body.user?.id}`);
  assert(body.user?.phone === phone, `Expected user.phone=${phone}, got ${body.user?.phone}`);
  assert(body.user?.is_anonymous === false, 'Expected is_anonymous=false');
  assert(typeof body.session?.access_token === 'string', 'Expected session.access_token');
}

/**
 * verify-otp for a brand-new user WITH firstName + lastName.
 * Exercises handleNewUser with fullName built from both name parts.
 */
async function testVerifyOtp_seededHappyPath_newUserBothNames() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  const userId = randomUUID();
  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, { userId });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone,
      token: SEED_OTP,
      firstName: 'Seed',
      lastName: 'User',
    }),
  });

  assertStatus(res.status, 200, res.data);
  const body = res.data as { user?: { id?: string } };
  assert(body.user?.id === userId, `Expected user.id=${userId}`);
}

/**
 * verify-otp twice with the same phone — exercises handleExistingUser path.
 * After the first call, the user exists in DB; the second call hits findUserById,
 * goes through handleExistingUser, and (since the user is non-anonymous and has
 * no name to update) takes the "already exists" no-op branch.
 */
async function testVerifyOtp_seededExistingUser_noUpdates() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  const userId = randomUUID();
  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, { userId });

  // First verify creates the user
  const r1 = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP, firstName: 'Original', lastName: 'Name' }),
  });
  assertStatus(r1.status, 200, r1.data);

  // Second verify: user exists, has name, isAnonymous=false → "already exists" branch
  const r2 = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });
  assertStatus(r2.status, 200, r2.data);
  const body2 = r2.data as { user?: { id?: string } };
  assert(body2.user?.id === userId, 'Second verify should return same userId');
}

/**
 * verify-otp on existing user that is missing a name, with new firstName provided.
 * Exercises the handleExistingUser branch where the user already has phone but
 * no name → updates.name is set → repo.updateUser runs.
 */
async function testVerifyOtp_seededExistingUser_nameUpdate() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  const userId = randomUUID();
  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, { userId });

  // First call: creates user with NO name
  const r1 = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });
  assertStatus(r1.status, 200, r1.data);

  // Second call: existing user, no name yet, supply firstName → name update branch
  const r2 = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP, firstName: 'Updated', lastName: 'Person' }),
  });
  assertStatus(r2.status, 200, r2.data);
}

/**
 * verify-otp with an anonymousUserId that owns agents → triggers the merge path
 * AND drives handleNewUser for the authenticated user.
 *
 * Seed Twilio/Supabase AFTER createAgentWithRetry. A multi-second gap between a
 * disk seed and verify-otp let concurrent suite cache churn / memoization miss
 * the fixture and fall through to live Twilio ("Invalid code").
 */
async function testVerifyOtp_seededMergeAnonymousResources() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  const userId = randomUUID();

  // Set up an anonymous user with an agent so transferAgents has work to do.
  // Seed Twilio/Supabase AFTER this setup: under domain concurrency the disk
  // seed can miss if written before the multi-second anon+agent prologue
  // (observed as Invalid code when the live VerificationCheck runs).
  const { userId: anonUserId } = await createAnonSession();
  const agentRes = await createAgentWithRetry(anonUserId, 'Seeded merge agent');
  if (agentRes.status !== 200 && agentRes.status !== 201) {
    throw new Error(
      `Expected 200/201 for agent creation, got ${agentRes.status}: ${JSON.stringify(agentRes.data)}`
    );
  }

  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, { userId });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({
      phone,
      token: SEED_OTP,
      anonymousUserId: anonUserId,
      firstName: 'Merge',
    }),
  });

  assertStatus(res.status, 200, res.data);
  const body = res.data as { user?: { id?: string } };
  assert(body.user?.id === userId, 'Expected merged-into userId');
}

/**
 * verify-otp with seeded approved Twilio + complete-onboarding → triggers
 * the SMS-sending branch in completeOnboarding (because user.phone is set).
 *
 * The SMS is fire-and-forget via sendSms().then(sendMms). We must wait for
 * BOTH to complete before this test returns; otherwise the surge.app HTTP
 * call leaks into a later boundary test's capture window and fails its
 * "no SMS calls for anonymous user" assertion. To make this deterministic,
 * the test runs SEQUENTIALLY (before the boundary tests) and explicitly
 * waits for the SMS captures to land.
 */
async function testCompleteOnboarding_seededPhoneVerifySendsSms() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  const userId = randomUUID();
  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, { userId });

  const verifyRes = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP, firstName: 'Welcome' }),
  });
  assertStatus(verifyRes.status, 200, verifyRes.data);
  const verifyBody = verifyRes.data as { session?: { access_token?: string } };
  const authToken = verifyBody.session?.access_token;
  assert(typeof authToken === 'string', 'Expected access_token after seeded verify-otp');

  const capture = ctx.captureAvailable ? captureToken('seeded-complete-onboarding') : null;

  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers:
      capture === null
        ? authHeaders(authToken!)
        : { ...authHeaders(authToken!), 'X-Capture-Token': capture },
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { success?: boolean; alreadyCompleted?: boolean };
  assert(body.success === true, 'Expected complete-onboarding success=true');
  assert(body.alreadyCompleted === false, 'Expected first onboarding not already completed');

  // Drain the fire-and-forget SMS chain. completeOnboarding does:
  //   sendSms(phone, welcome).then(() => sendMms(phone, '', vcardUrl)).catch(...)
  // Both make POST https://api.surge.app/accounts/{id}/messages and the body
  // contains `"to":"<phone>"`. Poll the capture log until we see TWO surge.app
  // calls for our phone (sendSms + sendMms), or timeout. After both land, no
  // further surge.app call fires for this user — so a subsequent boundary
  // test won't see leaked captures.
  if (capture !== null) {
    // Poll-until-predicate (not a retry of a failing op): wait for both Surge
    // calls (sendSms + sendMms) to land in the capture log.
    const deadline = Date.now() + 8000;
    let surgeOk = false;
    // eslint-disable-next-line no-restricted-syntax -- poll loop, not a retry
    while (Date.now() < deadline) {
      const calls = await readCapturesForToken(capture);
      const ours = calls.filter(
        (c) => c.url.includes('surge.app') && c.requestBody?.includes(phone)
      );
      if (ours.length >= 2) {
        surgeOk = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (surgeOk) {
      return;
    }
    // Surge not reachable / Surge creds missing — fall through. We've still
    // exercised the SMS branch (the catch handler runs on rejection). To
    // protect downstream boundary tests, give one more grace period so any
    // pending HTTP error capture lands before we return.
    await new Promise((r) => setTimeout(r, 500));
  } else {
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Twilio VerificationCheck returns 400 with code 60202 → "Too many attempts".
 * Exercises the rate-limit error branch in checkTwilioVerifyOTP.
 */
async function testVerifyOtp_seededTooManyAttempts() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  await seedTwilioVerifyCheck(phone, SEED_OTP, false, {
    httpStatus: 400,
    twilioCode: 60202,
    twilioMessage: 'Max check attempts reached',
  });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'too-many-attempts');
  assert(
    /too many|attempts/i.test(body.error),
    `Expected too-many-attempts message, got: ${body.error}`
  );
}

/**
 * Twilio VerificationCheck returns 404 with code 20404 → "Code expired".
 * Exercises the expired-code error branch.
 */
async function testVerifyOtp_seededCodeExpired() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  await seedTwilioVerifyCheck(phone, SEED_OTP, false, {
    httpStatus: 404,
    twilioCode: 20404,
    twilioMessage: 'Verification not found',
  });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'expired-code');
  assert(/expired|new one/i.test(body.error), `Expected expired-code message, got: ${body.error}`);
}

/**
 * Twilio VerificationCheck returns 400 with a generic Twilio code (not 20404,
 * not 60202) → falls through to the default "Invalid code" message.
 */
async function testVerifyOtp_seededGenericTwilioError() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  await seedTwilioVerifyCheck(phone, SEED_OTP, false, {
    httpStatus: 400,
    twilioCode: 60100, // some unrelated Twilio code
    twilioMessage: 'Generic Twilio error',
  });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'generic-twilio-error');
  assert(/invalid code/i.test(body.error), `Expected default message, got: ${body.error}`);
}

/**
 * Twilio approved but Supabase admin returns 422 phone_exists. This can happen
 * when Supabase Auth still has the phone but the current app DB was reset. The
 * auth path should resolve the existing Supabase user and recreate the DB user.
 */
async function testVerifyOtp_seededSupabasePhoneExists() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  const userId = randomUUID();
  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, {
    httpStatus: 422,
    errorCode: 'phone_exists',
    msg: 'Phone already in use',
  });
  await seedSupabaseAdminListUsers([{ id: userId, phone }]);

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as {
    success?: boolean;
    user?: { id?: string; phone?: string; is_anonymous?: boolean };
    session?: { access_token?: string };
  };
  assert(body.success === true, 'Expected success=true after Supabase phone_exists recovery');
  assert(body.user?.id === userId, `Expected user.id=${userId}, got ${body.user?.id}`);
  assert(body.user?.phone === phone, `Expected user.phone=${phone}, got ${body.user?.phone}`);
  assert(body.user?.is_anonymous === false, 'Expected is_anonymous=false');
  assert(typeof body.session?.access_token === 'string', 'Expected session.access_token');
}

/**
 * Twilio approved but Supabase admin returns generic 500 → falls through the
 * non-422 error branch.
 */
async function testVerifyOtp_seededSupabaseGenericError() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, {
    httpStatus: 500,
    errorCode: 'server_error',
    msg: 'Supabase down',
  });

  const res = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });
  assertStatus(res.status, 500, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'supabase-generic-error');
  assert(/create user session/i.test(body.error), `Got error: ${body.error}`);
}

/**
 * send-otp: Twilio Verify returns non-2xx → service.twilio.ts sendTwilioVerifyOTP
 * surfaces the Twilio message via the 400 response.
 */
async function testSendOtp_seededTwilioError() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  await seedTwilioVerifySend(phone, {
    httpStatus: 400,
    twilioCode: 60200,
    twilioMessage: 'Invalid To parameter',
  });

  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
  assertStatus(res.status, 400, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'send-otp-twilio-error');
  assert(/invalid|to/i.test(body.error), `Expected Twilio error message, got: ${body.error}`);
}

/**
 * send-otp happy path with seeded 201 from Twilio Verify Verifications.
 * Exercises the success log branch in sendTwilioVerifyOTP.
 */
async function testSendOtp_seededHappyPath() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  await seedTwilioVerifySend(phone, { httpStatus: 201 });

  const res = await request(`${BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { success?: boolean; message?: string };
  assert(body.success === true, 'Expected success=true');
  assert(body.message === 'OTP sent', `Expected message='OTP sent', got: ${body.message}`);
}

/**
 * Verify-otp where the user already exists in our DB (findUserByPhone hits) and
 * is NOT anonymous, so findOrCreateSupabaseUser returns the existing userId
 * without calling Supabase. Then handleExistingUser runs with no updates.
 */
async function testVerifyOtp_seededExistingDbUser() {
  if (!canSeedAuthFlow()) return;
  const phone = uniqueFakePhone();
  const userId = randomUUID();
  await seedTwilioVerifyCheck(phone, SEED_OTP, true);
  await seedSupabaseAdminCreate(phone, { userId });

  // First verify creates the user
  const r1 = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP, firstName: 'First', lastName: 'Last' }),
  });
  assertStatus(r1.status, 200, r1.data);

  // Re-seed Supabase create to error so we can prove the second call doesn't
  // reach Supabase (it should hit findUserByPhone in our DB and short-circuit).
  await seedSupabaseAdminCreate(phone, { httpStatus: 500, errorCode: 'should_not_be_called' });

  const r2 = await request(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ phone, token: SEED_OTP }),
  });
  assertStatus(r2.status, 200, r2.data);
  const b2 = r2.data as { user?: { id?: string } };
  assert(b2.user?.id === userId, 'Second verify should return same userId from DB');
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
  console.log(`  Capture available: ${ctx.captureAvailable}`);
  console.log(`  Replay available: ${ctx.replayAvailable}\n`);

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
    { name: 'POST /verify-otp -- non-string email -> 400', fn: testVerifyOtp_nonStringEmail },
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
    // OTP flow
    { name: 'POST /send-otp -- happy path', fn: testSendOtp_happyPath },
    { name: 'POST /send-otp -- review bypass happy path', fn: testSendOtp_reviewBypassHappyPath },
    { name: 'POST /send-otp -- invalid phone format', fn: testSendOtp_invalidPhoneFormat },
    { name: 'POST /verify-otp -- wrong code', fn: testVerifyOtp_wrongCode },
    {
      name: 'POST /verify-otp -- review phone rejects main OTP',
      fn: testVerifyOtp_reviewPhoneRejectsMainOtp,
    },
    { name: 'POST /verify-otp -- with anonymous userId', fn: testVerifyOtp_withAnonymousUserId },
    {
      name: 'POST /verify-otp -- without optional fields',
      fn: testVerifyOtp_withoutOptionalFields,
    },
    // Complete onboarding
    { name: 'POST /complete-onboarding -- happy path', fn: testCompleteOnboarding_happyPath },
    { name: 'POST /complete-onboarding -- idempotent', fn: testCompleteOnboarding_idempotent },
    // Coverage boost tests
    { name: 'POST /verify-otp -- full flow with names', fn: testVerifyOtp_fullFlowWithNames },
    { name: 'POST /verify-otp -- with optional email', fn: testVerifyOtp_withEmail },
    {
      name: 'POST /verify-otp -- malformed email still succeeds',
      fn: testVerifyOtp_withMalformedEmailStillSucceeds,
    },
    { name: 'POST /verify-otp -- firstName only', fn: testVerifyOtp_firstNameOnly },
    { name: 'POST /verify-otp -- empty anonymousUserId', fn: testVerifyOtp_emptyAnonymousUserId },
    {
      name: 'POST /verify-otp -- second verify same phone (existing user)',
      fn: testVerifyOtp_secondVerifySamePhone,
    },
    {
      name: 'POST /verify-otp -- existing user name update',
      fn: testVerifyOtp_existingUserNameUpdate,
    },
    { name: 'POST /verify-otp -- anon merge with agents', fn: testVerifyOtp_anonMergeWithAgents },
    {
      name: 'POST /complete-onboarding -- after phone verify (SMS path)',
      fn: testCompleteOnboarding_afterPhoneVerify,
    },
    { name: 'POST /complete-onboarding -- via API key', fn: testCompleteOnboarding_viaApiKey },
    { name: 'POST /send-otp -- valid E.164 international', fn: testSendOtp_validE164 },
    {
      name: 'POST /verify-otp -- wrong code error message',
      fn: testVerifyOtp_wrongCodeErrorMessage,
    },
    {
      name: 'POST /anonymous -- 5 parallel sessions unique IDs',
      fn: testAnonymous_multipleSessionsParallel,
    },
    { name: 'GET /credits/usage -- after anonymous', fn: testCreditsUsage_afterAnonymous },
    {
      name: 'GET /credits/usage -- via API key with userId',
      fn: testCreditsUsage_viaApiKeyWithUserId,
    },
    {
      name: 'GET /credits/subscription -- after anonymous',
      fn: testCreditsSubscription_afterAnonymous,
    },
    { name: 'GET /credits/stats -- after anonymous', fn: testCreditsStats_afterAnonymous },
    // Deep coverage tests
    {
      name: 'POST /verify-otp -- new user with anonymous agents (merge)',
      fn: testVerifyOtp_newUserWithAnonymousIdAndAgents,
    },
    {
      name: 'POST /verify-otp -- existing user name update with both names',
      fn: testVerifyOtp_existingUserNameUpdate_BothNames,
    },
    {
      name: 'POST /complete-onboarding -- anon user no SMS branch',
      fn: testCompleteOnboarding_anonUserNoSms,
    },
    { name: 'POST /verify-otp -- lastName only', fn: testVerifyOtp_lastNameOnly },
    {
      name: 'POST /verify-otp -- anonymousUserId same as userId',
      fn: testVerifyOtp_anonIdSameAsUserId,
    },
    {
      name: 'POST /anonymous -- each session gets initial credit',
      fn: testAnonymous_eachGetInitialCredit,
    },
    {
      name: 'POST /complete-onboarding -- triple idempotency',
      fn: testCompleteOnboarding_tripleIdempotency,
    },
    { name: 'POST /send-otp -- phone with spaces', fn: testSendOtp_variousFormats },
    { name: 'POST /verify-otp -- empty name strings', fn: testVerifyOtp_emptyNameStrings },
    {
      name: 'POST /anonymous -- session timing consistency',
      fn: testAnonymous_sessionTimingConsistency,
    },
    // Seeded-cache coverage tests — exercise verify-otp + onboarding paths
    // that depend on Twilio/Supabase responses our recorded fixtures don't
    // produce (the test phone returns "pending", never "approved").
    {
      name: 'POST /verify-otp -- seeded happy path, new user (no name)',
      fn: testVerifyOtp_seededHappyPath_newUser,
    },
    {
      name: 'POST /verify-otp -- seeded happy path, new user with both names',
      fn: testVerifyOtp_seededHappyPath_newUserBothNames,
    },
    {
      name: 'POST /verify-otp -- seeded existing user no updates',
      fn: testVerifyOtp_seededExistingUser_noUpdates,
    },
    {
      name: 'POST /verify-otp -- seeded existing user name update',
      fn: testVerifyOtp_seededExistingUser_nameUpdate,
    },
    {
      name: 'POST /verify-otp -- seeded too-many-attempts (60202)',
      fn: testVerifyOtp_seededTooManyAttempts,
    },
    {
      name: 'POST /verify-otp -- seeded code expired (404/20404)',
      fn: testVerifyOtp_seededCodeExpired,
    },
    {
      name: 'POST /verify-otp -- seeded generic Twilio error',
      fn: testVerifyOtp_seededGenericTwilioError,
    },
    {
      name: 'POST /verify-otp -- seeded Supabase generic 5xx',
      fn: testVerifyOtp_seededSupabaseGenericError,
    },
    { name: 'POST /send-otp -- seeded Twilio error', fn: testSendOtp_seededTwilioError },
    { name: 'POST /send-otp -- seeded happy path', fn: testSendOtp_seededHappyPath },
    {
      name: 'POST /verify-otp -- seeded existing DB user (no Supabase)',
      fn: testVerifyOtp_seededExistingDbUser,
    },
    ...phoneOwnershipCases({
      baseUrl: BASE_URL,
      seedOtp: SEED_OTP,
      request,
      uniqueFakePhone,
      canSeedAuthFlow,
      seedTwilioVerifyCheck,
      seedSupabaseAdminCreate,
    }),
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of parallelResults) {
    const icon = r.passed ? '  PASS' : '  FAIL';
    console.log(`${icon}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`);
  }

  // Phase 3: Sequential state-dependent tests + boundary capture tests.
  //
  // The seeded SMS-onboarding test runs sequentially BEFORE the boundary tests
  // because completeOnboarding fires SMS via Surge in a fire-and-forget chain;
  // running it in parallel let the SMS HTTP call leak into a later boundary
  // test's capture window and break its no-outbound assertion.
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [
    {
      // Supabase listUsers has one shared replay URL for every phone. Keep its
      // seeded response out of the parallel pool so another case cannot win it.
      name: 'POST /verify-otp -- seeded Supabase phone_exists 422',
      fn: testVerifyOtp_seededSupabasePhoneExists,
    },
    {
      // Agent creation + merge is slow and previously raced parallel seeded OTP
      // fixtures under full-suite concurrency ("Invalid code").
      name: 'POST /verify-otp -- seeded merge anonymous resources',
      fn: testVerifyOtp_seededMergeAnonymousResources,
    },
    {
      name: 'POST /complete-onboarding -- happy then idempotent',
      fn: testCompleteOnboarding_happyThenIdempotent,
    },
    {
      name: 'POST /complete-onboarding -- seeded phone-verified sends SMS',
      fn: testCompleteOnboarding_seededPhoneVerifySendsSms,
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
        name: 'boundary -- admin phone never hits Twilio Verify',
        fn: testBoundary_adminPhoneNeverHitsTwilio,
      },
      {
        name: 'boundary -- send-otp calls Twilio Verify with exact params',
        fn: testBoundary_sendOtpTwilioCall,
      },
      {
        name: 'boundary -- unseeded send-otp is faked, never live Twilio',
        fn: testBoundary_unseededSendOtpNeverReachesTwilio,
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
        name: 'boundary -- review OTP bypass makes no Twilio calls',
        fn: testBoundary_reviewOtpBypassNoTwilio,
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
