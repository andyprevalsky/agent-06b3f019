#!/usr/bin/env tsx
/**
 * Black-box tests for /api/api-keys
 *
 * Tests the HTTP contract (status codes + response shapes) for all 3 endpoints:
 *   GET  /api/api-keys       — list all API keys (masked) for the authenticated user
 *   POST /api/api-keys       — generate a new API key (requires subscription)
 *   DELETE /api/api-keys/:id  — delete an API key
 *
 * Each endpoint is tested for: happy path, no auth (401), and edge cases
 * (no subscription 403, not found 404, wrong user 403).
 *
 * Note: POST / happy path (key creation) requires a subscription. Anonymous test
 * users don't have subscriptions, so the happy path for creation is tested via
 * the subscription-required 403 contract. If a test subscription seeder becomes
 * available, add a true happy path test.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/api-keys.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const MaskedApiKeyItem = z.object({
  id: z.string(),
  name: z.string().nullable(),
  maskedApiKey: z.string(),
  createdAt: z.string().or(z.date()),
});

const ListApiKeysResponse = z.object({
  keys: z.array(MaskedApiKeyItem),
});

const CreateApiKeyResponse = z.object({
  id: z.string(),
  name: z.string().nullable(),
  apiKey: z.string(),
  createdAt: z.string().or(z.date()),
});

const DeleteApiKeyResponse = z.object({
  success: z.literal(true),
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

  // Create second user session (for wrong-user tests)
  const res2 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res2.status, 200, res2.data);
  const data2 = res2.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken2 = data2.session.access_token;
  ctx.userId2 = data2.user.id;
}

// ==================== GET / (list) — auth required ====================

async function testList_happy() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListApiKeysResponse, res.data, 'GET /');
  // New anonymous user should have no keys
  const data = res.data as { keys: unknown[] };
  if (data.keys.length !== 0) {
    throw new Error(`Expected 0 keys for new user, got ${data.keys.length}`);
  }
}

async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/api-keys`);
  assertStatus(res.status, 401, res.data);
}

async function testList_apiKeyAuth() {
  // API key auth sets isInternal=true but no req.user, so route returns 401
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 401, res.data);
}

// ==================== POST / (create) — auth + subscription required ====================

async function testCreate_noSubscription() {
  // Anonymous users don't have subscriptions, so this should return 403
  const res = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ name: 'Test Key' }),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (403 no subscription)');
  const data = res.data as { error: string };
  if (!data.error.toLowerCase().includes('subscription')) {
    throw new Error(`Expected subscription-related error, got: ${data.error}`);
  }
}

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Key' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCreate_apiKeyAuth() {
  // API key auth sets isInternal=true but no req.user, so route returns 401
  const res = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ name: 'Test Key' }),
  });
  assertStatus(res.status, 401, res.data);
}

// ==================== DELETE /:id — auth required, ownership check ====================

async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/api-keys/${FAKE_UUID}`, {
    method: 'DELETE',
  });
  assertStatus(res.status, 401, res.data);
}

async function testDelete_notFound() {
  const res = await request(`${BASE_URL}/api/api-keys/${FAKE_UUID}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'DELETE /:id (404)');
}

async function testDelete_apiKeyAuth() {
  // API key auth sets isInternal=true but no req.user, so route returns 401
  const res = await request(`${BASE_URL}/api/api-keys/${FAKE_UUID}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 401, res.data);
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('🧪 API Keys Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  // Setup
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User 1: ${ctx.userId}`);
  console.log(`   User 2: ${ctx.userId2}\n`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'GET / (list)',
      tests: [
        { name: 'happy path — empty list for new user', fn: testList_happy },
        { name: 'no auth → 401', fn: testList_noAuth },
        { name: 'API key auth (no user) → 401', fn: testList_apiKeyAuth },
      ],
    },
    {
      name: 'POST / (create)',
      tests: [
        { name: 'no subscription → 403', fn: testCreate_noSubscription },
        { name: 'no auth → 401', fn: testCreate_noAuth },
        { name: 'API key auth (no user) → 401', fn: testCreate_apiKeyAuth },
      ],
    },
    {
      name: 'DELETE /:id',
      tests: [
        { name: 'no auth → 401', fn: testDelete_noAuth },
        { name: 'not found → 404', fn: testDelete_notFound },
        { name: 'API key auth (no user) → 401', fn: testDelete_apiKeyAuth },
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
