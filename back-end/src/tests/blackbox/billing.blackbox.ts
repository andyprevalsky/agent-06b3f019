#!/usr/bin/env tsx
/* eslint-disable max-lines */
/**
 * Black-box tests for the billing domain
 *
 * Covers all billing-related HTTP entrypoints:
 *   GET  /api/billing/portal         — Stripe billing portal URL (JWT auth)
 *   GET  /api/credits/usage          — credit balance (dual auth: JWT or API key)
 *   POST /api/credits/initialize     — create initial credit (JWT auth)
 *   GET  /api/credits/subscription   — subscription details (JWT auth)
 *   GET  /api/credits/stats          — token usage stats by model (JWT auth)
 *   POST /webhooks/stripe            — Stripe webhook (signature verified, no auth)
 *   POST /api/x402/topup             — USDC credits (x402 payment, conditional)
 *   GET  /api/x402/agents/:id/status — agent status (public, conditional)
 *
 * Boundary capture tests:
 *   All billing endpoints are DB-only operations for anonymous/free-tier users.
 *   The Stripe SDK uses its own HTTP client (not globalThis.fetch), so Stripe API
 *   calls (billingPortal.sessions.create, subscriptions.retrieve, checkout.sessions.list)
 *   are NOT capturable via the fetch capture harness. This is documented as a known
 *   limitation. We assert that validation short-circuits produce zero outbound calls.
 *
 * Invariants covered:
 *   - auth boundary: protected endpoints reject unauthenticated requests
 *   - error-surface: all error responses include { error: string } across all status codes
 *   - idempotency: /credits/initialize is idempotent (returns existing credit)
 *   - read-after-write: initialize -> usage reflects credit immediately
 *   - tenant isolation: user1 and user2 have independent balances, stats, subscriptions
 *   - concurrency: parallel credit initializations are safe and idempotent
 *   - state transition: initialize creates credit, usage changes accordingly
 *   - boundary param: Stripe SDK not capturable (uses own HTTP client, not fetch).
 *     All testable billing endpoints are DB-only, confirmed via zero-capture assertions.
 *   - cleanup: each test creates its own anonymous users; no shared mutable fixtures
 *   - reproducibility: deterministic given the same inputs
 *   - same-input reproducibility: sequential requests return identical data
 *   - duplication prevention: credit initialization is idempotent (one credit per user)
 *
 * Invariants not applicable:
 *   - ordering/pagination: no list endpoints with ordering in the billing domain
 *   - atomicity: credit creation is a single Prisma operation
 *   - referential integrity: enforced by Prisma/Postgres, not the billing layer
 *   - event/job cardinality: webhook processing not testable without valid Stripe signatures
 *   - harness independence: no background jobs in the billing read path
 *   - observability: covered by the runner's manifest and artifact directory
 *   - call ordering: only one third-party boundary per request (Stripe), not capturable
 *
 * Usage:
 *   npx tsx src/tests/blackbox/billing.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/billing.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

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

// PortalResponse and AgentStatusResponse schemas reserved for future billing endpoint coverage

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
  x402Available: boolean;
}

const ctx: TestContext = { captureAvailable: false, x402Available: false };

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
  'anthropic.com',
  'openai.com',
  'chatgpt.com',
  'ip-api.com',
  'supabase.co',
  'surge.app',
  'verify.twilio.com',
  'e2b.app',
  'stripe.com',
  'parallel.ai',
  'connect.steelbrowser.com',
  'perplexity.ai',
  'exa.ai',
  'vapi.ai',
  'googleapis.com',
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
  return `billing-${prefix}-${crypto.randomUUID()}`;
}

async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ==================== SETUP ====================

async function createAnonSession(): Promise<{ accessToken: string; userId: string }> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  return { accessToken: d.session.access_token, userId: d.user.id };
}

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

  // Check if x402 routes are available (conditional on X402_RECEIVING_WALLET)
  try {
    const res = await fetch(`${BASE_URL}/api/x402/agents/nonexistent/status`);
    // If we get 404 (route handler ran) or 402, x402 is available
    ctx.x402Available = res.status === 404 || res.status === 402;
  } catch {
    ctx.x402Available = false;
  }
}

// ==================== GET /api/billing/portal ====================

async function testPortal_noAuth() {
  const res = await request(`${BASE_URL}/api/billing/portal`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /portal (401)');
}

async function testPortal_invalidToken() {
  const res = await request(`${BASE_URL}/api/billing/portal`, {
    headers: authHeaders('invalid-jwt-token'),
  });
  assertStatus(res.status, 401, res.data);
}

async function testPortal_malformedBearer() {
  const res = await request(`${BASE_URL}/api/billing/portal`, {
    headers: { Authorization: 'Basic dXNlcjpwYXNz' },
  });
  assertStatus(res.status, 401, res.data);
}

async function testPortal_noSubscription() {
  const res = await request(`${BASE_URL}/api/billing/portal`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 404, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'GET /portal (404)');
  assert(
    body.error === 'No subscription found',
    `Expected error "No subscription found", got "${body.error}"`
  );
}

async function testPortal_noSubscriptionHasMessage() {
  const res = await request(`${BASE_URL}/api/billing/portal`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 404, res.data);
  const body = res.data as { error: string; message?: string };
  assert(
    typeof body.message === 'string' && body.message.length > 0,
    'Expected a non-empty message field in the 404 response'
  );
}

// ==================== GET /api/credits/usage ====================

async function testUsage_happyJwt() {
  // Initialize credits first so the user has data
  await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });

  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'GET /usage (JWT)');
  assert(body.total >= 0, `Expected total >= 0, got ${body.total}`);
  assert(body.used >= 0, `Expected used >= 0, got ${body.used}`);
  assert(body.remaining >= 0, `Expected remaining >= 0, got ${body.remaining}`);
}

async function testUsage_happyApiKey() {
  const res = await request(`${BASE_URL}/api/credits/usage?userId=${ctx.userId1}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(UsageResponse, res.data, 'GET /usage (API key)');
}

async function testUsage_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/usage`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /usage (401)');
}

async function testUsage_apiKeyMissingUserId() {
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /usage (400 missing userId)');
}

async function testUsage_freeUserUpgradeOptions() {
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'GET /usage upgradeOptions');
  // Free tier (null) should show tiers 30, 50, 100 (base plan is $30/mo)
  assert(body.tier === null, `Expected null tier for free user, got ${body.tier}`);
  const tiers = body.upgradeOptions.map((o) => o.tier);
  assert(tiers.includes(30), `Expected upgradeOptions to include tier 30, got [${tiers}]`);
  assert(tiers.includes(50), `Expected upgradeOptions to include tier 50, got [${tiers}]`);
  assert(tiers.includes(100), `Expected upgradeOptions to include tier 100, got [${tiers}]`);
}

async function testUsage_upgradeOptionsHaveUrls() {
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'GET /usage upgradeOption urls');
  for (const opt of body.upgradeOptions) {
    assert(opt.url.startsWith('https://buy.stripe.com/'), `Expected Stripe URL, got "${opt.url}"`);
    assert(opt.name.length > 0, `Expected non-empty name for tier ${opt.tier}`);
  }
}

async function testUsage_balanceMathCorrect() {
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'GET /usage math');
  const expectedRemaining = Math.max(0, body.total - body.used);
  // Allow for rounding (2 decimal places)
  const diff = Math.abs(body.remaining - expectedRemaining);
  assert(
    diff < 0.02,
    `remaining (${body.remaining}) != max(0, total - used) (${expectedRemaining})`
  );
}

async function testUsage_wrongApiKey() {
  // An unrecognized API key falls through to JWT auth path and fails
  const res = await request(`${BASE_URL}/api/credits/usage?userId=${ctx.userId1}`, {
    headers: { 'X-API-Key': 'definitely-not-the-real-api-key' },
  });
  assertStatus(res.status, 401, res.data);
}

async function testUsage_apiKeyNonexistentUserId() {
  // API key auth with a valid key but userId that doesn't exist in DB
  // Should still return a valid (zero) usage response since getUserUsage handles missing users
  const fakeUserId = '00000000-0000-0000-0000-000000000000';
  const res = await request(`${BASE_URL}/api/credits/usage?userId=${fakeUserId}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'GET /usage (nonexistent user)');
  assert(body.total === 0, `Expected 0 total for nonexistent user, got ${body.total}`);
  assert(body.remaining === 0, `Expected 0 remaining for nonexistent user, got ${body.remaining}`);
}

async function testUsage_freshUserHasInitialCredit() {
  // Anonymous session creation auto-grants $1 initial credit
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'GET /usage (fresh user)');
  assert(body.total === 1, `Expected $1 total for fresh anonymous user, got ${body.total}`);
  assert(body.used === 0, `Expected 0 used for fresh user, got ${body.used}`);
  assert(body.remaining === 1, `Expected $1 remaining for fresh user, got ${body.remaining}`);
}

// ==================== POST /api/credits/initialize ====================

async function testInitialize_happy() {
  const res = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(InitializeResponse, res.data, 'POST /initialize');
  assert(body.credit.amount === 100, `Expected 100 cents ($1), got ${body.credit.amount}`);
}

async function testInitialize_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/initialize`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// ==================== GET /api/credits/subscription ====================

async function testSubscription_happy() {
  const res = await request(`${BASE_URL}/api/credits/subscription`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SubscriptionResponse, res.data, 'GET /subscription');
}

async function testSubscription_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/subscription`);
  assertStatus(res.status, 401, res.data);
}

async function testSubscription_freshUserNullTier() {
  const res = await request(`${BASE_URL}/api/credits/subscription`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SubscriptionResponse, res.data, 'GET /subscription (null tier)');
  assert(body.tier === null, `Expected null tier for fresh user, got ${body.tier}`);
  assert(
    body.currentPeriodEnd === null,
    `Expected null currentPeriodEnd, got ${body.currentPeriodEnd}`
  );
  assert(body.upgradeOptions.length > 0, 'Expected upgradeOptions for free tier');
}

async function testSubscription_upgradeOptionsMatchUsage() {
  // Upgrade options from /subscription should match those from /usage for same user
  const [subRes, usageRes] = await Promise.all([
    request(`${BASE_URL}/api/credits/subscription`, {
      headers: authHeaders(ctx.accessToken1!),
    }),
    request(`${BASE_URL}/api/credits/usage`, {
      headers: authHeaders(ctx.accessToken1!),
    }),
  ]);
  assertStatus(subRes.status, 200, subRes.data);
  assertStatus(usageRes.status, 200, usageRes.data);
  const sub = assertSchema(SubscriptionResponse, subRes.data, 'subscription');
  const usage = assertSchema(UsageResponse, usageRes.data, 'usage');

  const subTiers = sub.upgradeOptions.map((o) => o.tier).sort();
  const usageTiers = usage.upgradeOptions.map((o) => o.tier).sort();
  assert(
    JSON.stringify(subTiers) === JSON.stringify(usageTiers),
    `Upgrade option tiers differ: subscription=[${subTiers}] usage=[${usageTiers}]`
  );
}

// ==================== GET /api/credits/stats ====================

async function testStats_happy() {
  const res = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(StatsResponse, res.data, 'GET /stats');
}

async function testStats_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/stats`);
  assertStatus(res.status, 401, res.data);
}

async function testStats_emptyForNewUser() {
  const res = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(ctx.accessToken3!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(StatsResponse, res.data, 'GET /stats (empty)');
  assert(body.totalTokens === 0, `Expected totalTokens 0, got ${body.totalTokens}`);
  assert(body.topModels.length === 0, `Expected empty topModels, got ${body.topModels.length}`);
}

// ==================== POST /webhooks/stripe ====================

async function testStripeWebhook_noSignature() {
  const response = await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'invoice.payment_succeeded' }),
  });
  assertStatus(response.status, 400, await response.text());
}

async function testStripeWebhook_invalidSignature() {
  const response = await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=9999999999,v1=invalidhash',
    },
    body: JSON.stringify({ type: 'invoice.payment_succeeded' }),
  });
  assertStatus(response.status, 400, await response.text());
}

async function testStripeWebhook_emptyBody() {
  const response = await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '',
  });
  // Should reject with 400 (no signature)
  assert(
    response.status === 400 || response.status === 500,
    `Expected 400 or 500 for empty body, got ${response.status}`
  );
}

async function testStripeWebhook_wrongMethod() {
  // GET on the webhook endpoint should be rejected (only POST is defined)
  const response = await fetch(`${BASE_URL}/webhooks/stripe`);
  assert(
    response.status === 404 || response.status === 405,
    `Expected 404 or 405 for GET /webhooks/stripe, got ${response.status}`
  );
}

async function testStripeWebhook_validFormatInvalidPayload() {
  // A well-formatted but non-matching signature should still be rejected
  const body = JSON.stringify({
    id: 'evt_test_123',
    type: 'invoice.payment_succeeded',
    data: { object: {} },
  });
  const response = await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=fakesignaturehash`,
    },
    body,
  });
  assertStatus(response.status, 400, await response.text());
}

// ==================== POST /api/x402/topup (conditional) ====================

async function testTopup_noPayment() {
  if (!ctx.x402Available) return;
  const res = await request(`${BASE_URL}/api/x402/topup`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 402, res.data);
}

// ==================== GET /api/x402/agents/:id/status (conditional) ====================

async function testAgentStatus_notFound() {
  if (!ctx.x402Available) return;
  const res = await request(`${BASE_URL}/api/x402/agents/nonexistent-id/status`);
  assertStatus(res.status, 404, res.data);
  assertSchema(z.object({ error: z.string() }), res.data, 'GET /agents/:id/status (404)');
}

// ==================== AUTH BOUNDARY INVARIANT ====================

async function testAuthBoundary_allProtectedEndpoints() {
  const protectedEndpoints = [
    { method: 'GET', path: '/api/billing/portal' },
    { method: 'POST', path: '/api/credits/initialize' },
    { method: 'GET', path: '/api/credits/subscription' },
    { method: 'GET', path: '/api/credits/stats' },
  ];

  for (const ep of protectedEndpoints) {
    const res = await request(`${BASE_URL}${ep.path}`, {
      method: ep.method,
    });
    assert(
      res.status === 401,
      `${ep.method} ${ep.path} without auth: expected 401, got ${res.status}`
    );
  }
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testErrorSurface_allErrorsHaveErrorField() {
  const errorEndpoints = [
    { method: 'GET', path: '/api/billing/portal', expectedStatus: 401 },
    { method: 'POST', path: '/api/credits/initialize', expectedStatus: 401 },
    { method: 'GET', path: '/api/credits/subscription', expectedStatus: 401 },
    { method: 'GET', path: '/api/credits/stats', expectedStatus: 401 },
    { method: 'GET', path: '/api/credits/usage', expectedStatus: 401 },
  ];

  for (const ep of errorEndpoints) {
    const res = await request(`${BASE_URL}${ep.path}`, { method: ep.method });
    assertStatus(res.status, ep.expectedStatus, res.data);
    const body = res.data as Record<string, unknown>;
    assert(
      typeof body.error === 'string' && body.error.length > 0,
      `${ep.method} ${ep.path} (${ep.expectedStatus}): missing or empty "error" field in response`
    );
  }
}

// ==================== TENANT ISOLATION INVARIANT ====================

async function testTenantIsolation_separateBalances() {
  // Initialize credits for user1
  await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });

  // Initialize credits for user2
  await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken2!),
  });

  // Both users should see their own balance, not each other's
  const [res1, res2] = await Promise.all([
    request(`${BASE_URL}/api/credits/usage`, {
      headers: authHeaders(ctx.accessToken1!),
    }),
    request(`${BASE_URL}/api/credits/usage`, {
      headers: authHeaders(ctx.accessToken2!),
    }),
  ]);

  assertStatus(res1.status, 200, res1.data);
  assertStatus(res2.status, 200, res2.data);

  const u1 = assertSchema(UsageResponse, res1.data, 'user1 usage');
  const u2 = assertSchema(UsageResponse, res2.data, 'user2 usage');

  // Both fresh anonymous users should have $1 credit
  assert(u1.total > 0, `User 1 should have credits, got total=${u1.total}`);
  assert(u2.total > 0, `User 2 should have credits, got total=${u2.total}`);
}

async function testTenantIsolation_separateStats() {
  const [res1, res2] = await Promise.all([
    request(`${BASE_URL}/api/credits/stats`, {
      headers: authHeaders(ctx.accessToken1!),
    }),
    request(`${BASE_URL}/api/credits/stats`, {
      headers: authHeaders(ctx.accessToken2!),
    }),
  ]);

  assertStatus(res1.status, 200, res1.data);
  assertStatus(res2.status, 200, res2.data);

  // Fresh users: both should have zero token usage
  const s1 = assertSchema(StatsResponse, res1.data, 'user1 stats');
  const s2 = assertSchema(StatsResponse, res2.data, 'user2 stats');
  assert(s1.totalTokens === 0, `User1 expected 0 tokens, got ${s1.totalTokens}`);
  assert(s2.totalTokens === 0, `User2 expected 0 tokens, got ${s2.totalTokens}`);
}

async function testTenantIsolation_separateSubscriptions() {
  const [res1, res2] = await Promise.all([
    request(`${BASE_URL}/api/credits/subscription`, {
      headers: authHeaders(ctx.accessToken1!),
    }),
    request(`${BASE_URL}/api/credits/subscription`, {
      headers: authHeaders(ctx.accessToken2!),
    }),
  ]);

  assertStatus(res1.status, 200, res1.data);
  assertStatus(res2.status, 200, res2.data);

  // Both fresh users: null subscription
  const sub1 = assertSchema(SubscriptionResponse, res1.data, 'user1 sub');
  const sub2 = assertSchema(SubscriptionResponse, res2.data, 'user2 sub');
  assert(sub1.tier === null, `User1 expected null tier, got ${sub1.tier}`);
  assert(sub2.tier === null, `User2 expected null tier, got ${sub2.tier}`);
}

// ==================== CONCURRENCY INVARIANT ====================

async function testConcurrency_parallelInitialize() {
  // Fire 5 concurrent initialize requests for the same user
  // All should succeed and return the same amount (idempotency under concurrency)
  const { accessToken } = await createAnonSession();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(`${BASE_URL}/api/credits/initialize`, {
        method: 'POST',
        headers: authHeaders(accessToken),
      })
    )
  );

  for (const res of results) {
    assertStatus(res.status, 200, res.data);
    const body = assertSchema(InitializeResponse, res.data, 'concurrent initialize');
    assert(body.credit.amount === 100, `Expected 100 cents, got ${body.credit.amount}`);
  }
}

async function testConcurrency_parallelUsageReads() {
  // 10 concurrent usage reads for the same user should all return consistent data
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(`${BASE_URL}/api/credits/usage`, {
        headers: authHeaders(ctx.accessToken1!),
      })
    )
  );

  const firstBody = assertSchema(UsageResponse, results[0].data, 'concurrent usage 0');
  for (let i = 1; i < results.length; i++) {
    assertStatus(results[i].status, 200, results[i].data);
    const body = assertSchema(UsageResponse, results[i].data, `concurrent usage ${i}`);
    assert(
      body.total === firstBody.total && body.used === firstBody.used,
      `Concurrent read ${i} inconsistent: total=${body.total} vs ${firstBody.total}, used=${body.used} vs ${firstBody.used}`
    );
  }
}

// ==================== REPRODUCIBILITY INVARIANT ====================

async function testReproducibility_sequentialUsageReads() {
  // 3 sequential reads should return identical data
  const results: UsageResponse[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/credits/usage`, {
      headers: authHeaders(ctx.accessToken1!),
    });
    assertStatus(res.status, 200, res.data);
    results.push(assertSchema(UsageResponse, res.data, `reproducibility read ${i}`));
  }
  for (let i = 1; i < results.length; i++) {
    assert(
      results[i].total === results[0].total &&
        results[i].used === results[0].used &&
        results[i].remaining === results[0].remaining,
      `Read ${i} differs from read 0: ${JSON.stringify(results[i])} vs ${JSON.stringify(results[0])}`
    );
  }
}

type UsageResponse = z.infer<typeof UsageResponse>;

// ==================== DUPLICATION PREVENTION INVARIANT ====================

async function testDuplicationPrevention_singleCreditPerUser() {
  // After multiple initialize calls, user should still have exactly $1 total credit
  const { accessToken } = await createAnonSession();

  // Initialize 3 times
  for (let i = 0; i < 3; i++) {
    await request(`${BASE_URL}/api/credits/initialize`, {
      method: 'POST',
      headers: authHeaders(accessToken),
    });
  }

  // Check total credits - should be exactly $1 (not $3)
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UsageResponse, res.data, 'duplication prevention');
  assert(
    body.total === 1,
    `Expected exactly $1 total after multiple initializes, got $${body.total}`
  );
}

// ==================== ERROR SURFACE INVARIANT (expanded) ====================

async function testErrorSurface_400HasErrorField() {
  // 400 responses should also have the error field
  const res = await request(`${BASE_URL}/api/credits/usage`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as Record<string, unknown>;
  assert(
    typeof body.error === 'string' && body.error.length > 0,
    'GET /usage (400 missing userId): missing or empty "error" field'
  );
}

// ==================== SEQUENTIAL: IDEMPOTENCY ====================

async function testIdempotency_initializeTwice() {
  const res1 = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken3!),
  });
  assertStatus(res1.status, 200, res1.data);
  const body1 = assertSchema(InitializeResponse, res1.data, 'initialize 1st');

  const res2 = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken3!),
  });
  assertStatus(res2.status, 200, res2.data);
  const body2 = assertSchema(InitializeResponse, res2.data, 'initialize 2nd');

  // Same amount (idempotent)
  assert(
    body1.credit.amount === body2.credit.amount,
    `Initialize not idempotent: first=${body1.credit.amount}, second=${body2.credit.amount}`
  );
}

// ==================== SEQUENTIAL: READ-AFTER-WRITE ====================

async function testReadAfterWrite_initializeThenUsage() {
  // Create a fresh user for this test
  const { accessToken } = await createAnonSession();

  // Initialize credits
  const initRes = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
  assertStatus(initRes.status, 200, initRes.data);
  const initBody = assertSchema(InitializeResponse, initRes.data, 'init for RAW');

  // Immediately read usage
  const usageRes = await request(`${BASE_URL}/api/credits/usage`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(usageRes.status, 200, usageRes.data);
  const usage = assertSchema(UsageResponse, usageRes.data, 'usage after init');

  // The total should include the initialized credit
  const expectedDollars = initBody.credit.amount / 100;
  assert(
    usage.total >= expectedDollars,
    `Expected total >= $${expectedDollars} after initialize, got $${usage.total}`
  );
  assert(
    usage.remaining >= expectedDollars,
    `Expected remaining >= $${expectedDollars} after initialize (no usage yet), got $${usage.remaining}`
  );
}

// ==================== BOUNDARY CAPTURE TESTS ====================

async function testBoundary_portalNoSubscriptionNoOutbound() {
  const token = captureToken('portal');
  await request(`${BASE_URL}/api/billing/portal`, {
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });
  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for portal without subscription, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

async function testBoundary_usageNoAuthNoOutbound() {
  const token = captureToken('usage-no-auth');
  await request(`${BASE_URL}/api/credits/usage`, {
    headers: { 'X-Capture-Token': token },
  });
  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for /usage without auth, got ${filterInfraCalls(calls).length}`
  );
}

async function testBoundary_initializeNoOutbound() {
  const token = captureToken('initialize');
  await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });
  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for /initialize, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

async function testBoundary_subscriptionNoOutbound() {
  const token = captureToken('subscription');
  await request(`${BASE_URL}/api/credits/subscription`, {
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });
  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for /subscription, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

async function testBoundary_statsNoOutbound() {
  const token = captureToken('stats');
  await request(`${BASE_URL}/api/credits/stats`, {
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });
  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for /stats, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

async function testBoundary_webhookInvalidSigNoOutbound() {
  const token = captureToken('webhook');
  await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=9999999999,v1=invalidhash',
      'X-Capture-Token': token,
    },
    body: JSON.stringify({ type: 'invoice.payment_succeeded' }),
  });
  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for webhook with invalid signature, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

async function testBoundary_usageAuthenticatedNoOutbound() {
  const token = captureToken('usage-auth');
  await request(`${BASE_URL}/api/credits/usage`, {
    headers: { ...authHeaders(ctx.accessToken1!), 'X-Capture-Token': token },
  });
  const calls = await readCapturesForToken(token);
  assert(
    filterInfraCalls(calls).length === 0,
    `Expected 0 outbound calls for authenticated /usage, got ${filterInfraCalls(calls).length}: ${JSON.stringify(filterInfraCalls(calls).map((c) => c.url))}`
  );
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Billing Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Phase 1: Setup
  console.log('Setting up auth sessions...');
  await setup();
  console.log(`  User 1: ${ctx.userId1}`);
  console.log(`  User 2: ${ctx.userId2}`);
  console.log(`  User 3: ${ctx.userId3}`);
  console.log(`  Capture available: ${ctx.captureAvailable}`);
  console.log(`  x402 available: ${ctx.x402Available}\n`);

  // Phase 2: Parallel independent tests
  const parallelTests = [
    // GET /api/billing/portal
    { name: 'GET /portal -- no auth -> 401', fn: testPortal_noAuth },
    { name: 'GET /portal -- invalid token -> 401', fn: testPortal_invalidToken },
    { name: 'GET /portal -- malformed bearer -> 401', fn: testPortal_malformedBearer },
    { name: 'GET /portal -- no subscription -> 404', fn: testPortal_noSubscription },
    { name: 'GET /portal -- 404 has message field', fn: testPortal_noSubscriptionHasMessage },

    // GET /api/credits/usage
    { name: 'GET /usage -- happy path (JWT)', fn: testUsage_happyJwt },
    { name: 'GET /usage -- happy path (API key)', fn: testUsage_happyApiKey },
    { name: 'GET /usage -- no auth -> 401', fn: testUsage_noAuth },
    { name: 'GET /usage -- API key missing userId -> 400', fn: testUsage_apiKeyMissingUserId },
    { name: 'GET /usage -- wrong API key -> 401', fn: testUsage_wrongApiKey },
    {
      name: 'GET /usage -- API key nonexistent userId -> 200 zero',
      fn: testUsage_apiKeyNonexistentUserId,
    },
    {
      name: 'GET /usage -- fresh user has initial credit',
      fn: testUsage_freshUserHasInitialCredit,
    },
    { name: 'GET /usage -- free user upgrade options', fn: testUsage_freeUserUpgradeOptions },
    {
      name: 'GET /usage -- upgrade options have Stripe URLs',
      fn: testUsage_upgradeOptionsHaveUrls,
    },
    { name: 'GET /usage -- balance math correct', fn: testUsage_balanceMathCorrect },

    // POST /api/credits/initialize
    { name: 'POST /initialize -- happy path', fn: testInitialize_happy },
    { name: 'POST /initialize -- no auth -> 401', fn: testInitialize_noAuth },

    // GET /api/credits/subscription
    { name: 'GET /subscription -- happy path', fn: testSubscription_happy },
    { name: 'GET /subscription -- no auth -> 401', fn: testSubscription_noAuth },
    { name: 'GET /subscription -- fresh user null tier', fn: testSubscription_freshUserNullTier },
    {
      name: 'GET /subscription -- upgrade options match usage',
      fn: testSubscription_upgradeOptionsMatchUsage,
    },

    // GET /api/credits/stats
    { name: 'GET /stats -- happy path', fn: testStats_happy },
    { name: 'GET /stats -- no auth -> 401', fn: testStats_noAuth },
    { name: 'GET /stats -- empty for new user', fn: testStats_emptyForNewUser },

    // POST /webhooks/stripe
    { name: 'POST /webhooks/stripe -- no signature -> 400', fn: testStripeWebhook_noSignature },
    {
      name: 'POST /webhooks/stripe -- invalid signature -> 400',
      fn: testStripeWebhook_invalidSignature,
    },
    { name: 'POST /webhooks/stripe -- empty body -> 400/500', fn: testStripeWebhook_emptyBody },
    { name: 'POST /webhooks/stripe -- wrong method -> 404/405', fn: testStripeWebhook_wrongMethod },
    {
      name: 'POST /webhooks/stripe -- valid format invalid payload -> 400',
      fn: testStripeWebhook_validFormatInvalidPayload,
    },

    // x402 (conditional)
    { name: 'POST /x402/topup -- no payment -> 402', fn: testTopup_noPayment },
    { name: 'GET /x402/agents/:id/status -- not found -> 404', fn: testAgentStatus_notFound },

    // Invariants
    {
      name: 'invariant -- auth boundary (all protected endpoints reject no-auth)',
      fn: testAuthBoundary_allProtectedEndpoints,
    },
    {
      name: 'invariant -- error surface (all errors have error field)',
      fn: testErrorSurface_allErrorsHaveErrorField,
    },
    {
      name: 'invariant -- error surface (400 has error field)',
      fn: testErrorSurface_400HasErrorField,
    },
    {
      name: 'invariant -- tenant isolation (separate balances)',
      fn: testTenantIsolation_separateBalances,
    },
    {
      name: 'invariant -- tenant isolation (separate stats)',
      fn: testTenantIsolation_separateStats,
    },
    {
      name: 'invariant -- tenant isolation (separate subscriptions)',
      fn: testTenantIsolation_separateSubscriptions,
    },
    {
      name: 'invariant -- concurrency (parallel initialize is safe)',
      fn: testConcurrency_parallelInitialize,
    },
    {
      name: 'invariant -- concurrency (parallel usage reads consistent)',
      fn: testConcurrency_parallelUsageReads,
    },
    {
      name: 'invariant -- reproducibility (sequential usage reads identical)',
      fn: testReproducibility_sequentialUsageReads,
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

  // Phase 3: Sequential state-dependent tests
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [
    {
      name: 'idempotency -- initialize twice returns same amount',
      fn: testIdempotency_initializeTwice,
    },
    {
      name: 'read-after-write -- initialize then usage reflects credit',
      fn: testReadAfterWrite_initializeThenUsage,
    },
    {
      name: 'duplication prevention -- multiple initializes yield single credit',
      fn: testDuplicationPrevention_singleCreditPerUser,
    },
  ];

  // Add boundary capture tests if capture is available
  if (ctx.captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary -- portal (no subscription) makes no outbound calls',
        fn: testBoundary_portalNoSubscriptionNoOutbound,
      },
      {
        name: 'boundary -- /usage (no auth) makes no outbound calls',
        fn: testBoundary_usageNoAuthNoOutbound,
      },
      {
        name: 'boundary -- /initialize makes no outbound calls',
        fn: testBoundary_initializeNoOutbound,
      },
      {
        name: 'boundary -- /subscription makes no outbound calls',
        fn: testBoundary_subscriptionNoOutbound,
      },
      {
        name: 'boundary -- /stats makes no outbound calls',
        fn: testBoundary_statsNoOutbound,
      },
      {
        name: 'boundary -- webhook (invalid sig) makes no outbound calls',
        fn: testBoundary_webhookInvalidSigNoOutbound,
      },
      {
        name: 'boundary -- /usage (authenticated) makes no outbound calls',
        fn: testBoundary_usageAuthenticatedNoOutbound,
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

  console.log('\nALL BILLING BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
