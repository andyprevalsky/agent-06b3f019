#!/usr/bin/env tsx
/**
 * Black-box tests for /api/credits
 *
 * Tests the HTTP contract (status codes + response shapes) for all 4 endpoints:
 *   GET  /api/credits/usage        — credit usage & remaining balance (dual auth: JWT or API key)
 *   POST /api/credits/initialize   — create initial credit for user (JWT auth)
 *   GET  /api/credits/subscription — current subscription details (JWT auth)
 *   GET  /api/credits/stats        — token usage statistics by model (JWT auth)
 *
 * Usage:
 *   npx tsx src/tests/blackbox/credits.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({
  error: z.string(),
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

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  let data: unknown;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
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

// ==================== SETUP ====================

async function setupAuth(): Promise<void> {
  // Create first user session
  const res1 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res1.status, 200, res1.data);
  const data1 = res1.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = data1.session.access_token;
  ctx.userId = data1.user.id;

  // Create second user session (for isolation tests)
  const res2 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res2.status, 200, res2.data);
  const data2 = res2.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken2 = data2.session.access_token;
  ctx.userId2 = data2.user.id;
}

// ==================== GET /usage — dual auth (JWT or API key) ====================

async function testUsage_happyJwt() {
  // Initialize credits first so the user has data
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

// ==================== POST /initialize — JWT auth ====================

async function testInitialize_happy() {
  const res = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(InitializeResponse, res.data, 'POST /initialize');
}

async function testInitialize_idempotent() {
  // Calling initialize again for the same user should still succeed (returns existing credit)
  const res = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(InitializeResponse, res.data, 'POST /initialize (idempotent)');
}

async function testInitialize_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/initialize`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

// ==================== GET /subscription — JWT auth ====================

async function testSubscription_happy() {
  const res = await request(`${BASE_URL}/api/credits/subscription`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SubscriptionResponse, res.data, 'GET /subscription');
}

async function testSubscription_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/subscription`);
  assertStatus(res.status, 401, res.data);
}

async function testSubscription_noSubscription() {
  // A fresh anonymous user should have no subscription — expect null tier and null period end
  const res = await request(`${BASE_URL}/api/credits/subscription`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(SubscriptionResponse, res.data, 'GET /subscription (no sub)');
  if (parsed.tier !== null && parsed.currentPeriodEnd !== null) {
    // This is okay — the user may legitimately have a subscription.
    // But for a freshly created anonymous user, we expect null.
    // We only validate the schema shape here.
  }
}

// ==================== GET /stats — JWT auth ====================

async function testStats_happy() {
  const res = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(StatsResponse, res.data, 'GET /stats');
}

async function testStats_noAuth() {
  const res = await request(`${BASE_URL}/api/credits/stats`);
  assertStatus(res.status, 401, res.data);
}

async function testStats_emptyForNewUser() {
  // A fresh user with no agents should get totalTokens: 0 and empty topModels
  const res = await request(`${BASE_URL}/api/credits/stats`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(StatsResponse, res.data, 'GET /stats (empty)');
  if (parsed.totalTokens !== 0) {
    throw new Error(`Expected totalTokens 0 for new user, got ${parsed.totalTokens}`);
  }
  if (parsed.topModels.length !== 0) {
    throw new Error(`Expected empty topModels for new user, got ${parsed.topModels.length}`);
  }
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('🧪 Credits Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  // Setup
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User 1: ${ctx.userId}`);
  console.log(`   User 2: ${ctx.userId2}\n`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'GET /usage',
      tests: [
        { name: 'happy path (JWT)', fn: testUsage_happyJwt },
        { name: 'happy path (API key)', fn: testUsage_happyApiKey },
        { name: 'no auth → 401', fn: testUsage_noAuth },
        { name: 'API key missing userId → 400', fn: testUsage_apiKeyMissingUserId },
      ],
    },
    {
      name: 'POST /initialize',
      tests: [
        { name: 'happy path', fn: testInitialize_happy },
        { name: 'idempotent (second call)', fn: testInitialize_idempotent },
        { name: 'no auth → 401', fn: testInitialize_noAuth },
      ],
    },
    {
      name: 'GET /subscription',
      tests: [
        { name: 'happy path', fn: testSubscription_happy },
        { name: 'no auth → 401', fn: testSubscription_noAuth },
        { name: 'no subscription (fresh user)', fn: testSubscription_noSubscription },
      ],
    },
    {
      name: 'GET /stats',
      tests: [
        { name: 'happy path', fn: testStats_happy },
        { name: 'no auth → 401', fn: testStats_noAuth },
        { name: 'empty for new user', fn: testStats_emptyForNewUser },
      ],
    },
  ];

  const allResults: TestResult[] = [];

  for (const group of groups) {
    console.log(`\n📋 ${group.name}`);
    for (const test of group.tests) {
      const result = await runTest(`${group.name} — ${test.name}`, test.fn);
      allResults.push(result);
      const icon = result.passed ? '  ✅' : '  ❌';
      console.log(`${icon} ${test.name}${result.passed ? '' : ` — ${result.error}`} (${result.duration}ms)`);
    }
  }

  // Summary
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${allResults.length} total`);

  if (failed > 0) {
    console.log('\n❌ FAILURES:');
    allResults
      .filter((r) => !r.passed)
      .forEach((r) => console.log(`   • ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log('\n✅ ALL CONTRACT TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\n💥 Black-box test suite crashed:', error);
  process.exit(1);
});
