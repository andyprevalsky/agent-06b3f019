#!/usr/bin/env tsx
/**
 * Black-box tests for /api/user-settings
 *
 * Tests the HTTP contract (status codes + response shapes) for all 3 endpoints:
 *   GET  /api/user-settings    — get user settings (JWT or API key auth)
 *   PUT  /api/user-settings    — full update / upsert (JWT auth only)
 *   PATCH /api/user-settings   — partial update (JWT auth only)
 *
 * Each endpoint is tested for: happy path, no auth (401), bad input (400) where applicable.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/user-settings.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({
  error: z.string(),
  details: z.array(z.any()).optional(),
});

/** Shape returned by GET /api/user-settings */
const GetUserSettingsResponse = z.object({
  name: z.string().nullable(),
  phone: z.string().nullable().optional(), // present when user record exists
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  encryptedPaymentInformation: z.string().nullable(),
  onboardingCompletedAt: z.string().nullable().optional(), // present when user record exists
  systemName: z.string().nullable(),
  profilePicture: z.string().nullable(),
  customSystemPrompt: z.string().nullable(),
});

/** Shape returned by PUT and PATCH /api/user-settings */
const MutateUserSettingsResponse = z.object({
  name: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  encryptedPaymentInformation: z.string().nullable(),
  systemName: z.string().nullable(),
  profilePicture: z.string().nullable(),
  customSystemPrompt: z.string().nullable(),
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

function apiKeyHeaders(userId: string): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-User-Id': userId };
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

  // Create second user session (for cross-user isolation tests)
  const res2 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res2.status, 200, res2.data);
  const data2 = res2.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken2 = data2.session.access_token;
  ctx.userId2 = data2.user.id;
}

// ==================== GET / — auth required (JWT or API key) ====================

async function testGet_happy() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GetUserSettingsResponse, res.data, 'GET /');
}

async function testGet_apiKey() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    headers: apiKeyHeaders(ctx.userId!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GetUserSettingsResponse, res.data, 'GET / (API key)');
}

async function testGet_noAuth() {
  const res = await request(`${BASE_URL}/api/user-settings`);
  assertStatus(res.status, 401, res.data);
}

async function testGet_defaultsForNewUser() {
  // A freshly created anonymous user with no User record should get defaults
  const res = await request(`${BASE_URL}/api/user-settings`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetUserSettingsResponse, res.data, 'GET / (defaults)');
  // country defaults to 'United States' when no user record exists
  if (body.country !== 'United States' && body.country !== null) {
    throw new Error(`Expected country to be 'United States' or null, got '${body.country}'`);
  }
}

// ==================== PUT / — auth required (JWT only) ====================

async function testPut_happy() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      name: 'Contract Test User',
      city: 'San Francisco',
      state: 'CA',
      country: 'United States',
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(MutateUserSettingsResponse, res.data, 'PUT /');
  if (body.name !== 'Contract Test User') {
    throw new Error(`Expected name 'Contract Test User', got '${body.name}'`);
  }
  if (body.city !== 'San Francisco') {
    throw new Error(`Expected city 'San Francisco', got '${body.city}'`);
  }
}

async function testPut_noAuth() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'No Auth User' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testPut_emptyBody() {
  // Empty object is valid — all fields are optional in the schema
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(MutateUserSettingsResponse, res.data, 'PUT / (empty body)');
}

async function testPut_badInput_systemNameTooLong() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      systemName: 'a'.repeat(51), // max(50) should reject
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'PUT / (400 systemName too long)');
}

async function testPut_badInput_profilePictureTooLong() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      profilePicture: 'a'.repeat(501), // max(500) should reject
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'PUT / (400 profilePicture too long)');
}

async function testPut_badInput_customSystemPromptTooLong() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      customSystemPrompt: 'a'.repeat(2001), // max(2000) should reject
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'PUT / (400 customSystemPrompt too long)');
}

async function testPut_badInput_invalidFieldType() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      name: 12345, // should be string
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'PUT / (400 invalid type)');
}

async function testPut_nullableFields() {
  // Setting nullable fields to null should succeed
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      encryptedPaymentInformation: null,
      systemName: null,
      profilePicture: null,
      customSystemPrompt: null,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(MutateUserSettingsResponse, res.data, 'PUT / (nullable)');
  if (body.systemName !== null) {
    throw new Error(`Expected systemName to be null, got '${body.systemName}'`);
  }
}

async function testPut_verifyUpsertCreatesRecord() {
  // User2 has never PUT before — this should create a new record (upsert)
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken2!),
    body: JSON.stringify({ name: 'User Two' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(MutateUserSettingsResponse, res.data, 'PUT / (upsert create)');
  if (body.name !== 'User Two') {
    throw new Error(`Expected name 'User Two', got '${body.name}'`);
  }
}

// ==================== PATCH / — auth required (JWT only) ====================

async function testPatch_happy() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      city: 'Los Angeles',
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(MutateUserSettingsResponse, res.data, 'PATCH /');
  if (body.city !== 'Los Angeles') {
    throw new Error(`Expected city 'Los Angeles', got '${body.city}'`);
  }
}

async function testPatch_noAuth() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'No Auth' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testPatch_partialUpdatePreservesOtherFields() {
  // First PUT to set known state
  await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      name: 'Preserve Test',
      city: 'Chicago',
      state: 'IL',
    }),
  });

  // PATCH only city — name and state should be preserved
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ city: 'New York' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(MutateUserSettingsResponse, res.data, 'PATCH / (partial)');
  if (body.name !== 'Preserve Test') {
    throw new Error(`Expected name 'Preserve Test' to be preserved, got '${body.name}'`);
  }
  if (body.city !== 'New York') {
    throw new Error(`Expected city 'New York', got '${body.city}'`);
  }
  if (body.state !== 'IL') {
    throw new Error(`Expected state 'IL' to be preserved, got '${body.state}'`);
  }
}

async function testPatch_badInput_systemNameTooLong() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      systemName: 'a'.repeat(51), // max(50) should reject
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'PATCH / (400 systemName too long)');
}

async function testPatch_badInput_invalidFieldType() {
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      city: 99999, // should be string
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'PATCH / (400 invalid type)');
}

async function testPatch_emptyBody() {
  // Empty object is valid — no fields to update
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(MutateUserSettingsResponse, res.data, 'PATCH / (empty body)');
}

async function testPatch_nullableFields() {
  // Setting nullable fields to null via PATCH
  const res = await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      systemName: null,
      customSystemPrompt: null,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(MutateUserSettingsResponse, res.data, 'PATCH / (nullable)');
  if (body.systemName !== null) {
    throw new Error(`Expected systemName to be null, got '${body.systemName}'`);
  }
  if (body.customSystemPrompt !== null) {
    throw new Error(`Expected customSystemPrompt to be null, got '${body.customSystemPrompt}'`);
  }
}

// ==================== CROSS-ENDPOINT: GET reflects PUT/PATCH ====================

async function testGetReflectsPut() {
  // PUT a known value
  await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      name: 'Roundtrip Test',
      systemName: 'MyAgent',
    }),
  });

  // GET should reflect it
  const res = await request(`${BASE_URL}/api/user-settings`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetUserSettingsResponse, res.data, 'GET / (after PUT)');
  if (body.name !== 'Roundtrip Test') {
    throw new Error(`Expected name 'Roundtrip Test', got '${body.name}'`);
  }
  if (body.systemName !== 'MyAgent') {
    throw new Error(`Expected systemName 'MyAgent', got '${body.systemName}'`);
  }
}

async function testGetReflectsPatch() {
  // PATCH to change city
  await request(`${BASE_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ city: 'Boston' }),
  });

  // GET should reflect the patched city
  const res = await request(`${BASE_URL}/api/user-settings`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetUserSettingsResponse, res.data, 'GET / (after PATCH)');
  if (body.city !== 'Boston') {
    throw new Error(`Expected city 'Boston', got '${body.city}'`);
  }
}

async function testUserIsolation() {
  // User1 sets a distinctive name
  await request(`${BASE_URL}/api/user-settings`, {
    method: 'PUT',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ name: 'User One Isolation' }),
  });

  // User2 should NOT see User1's name
  const res = await request(`${BASE_URL}/api/user-settings`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetUserSettingsResponse, res.data, 'GET / (user isolation)');
  if (body.name === 'User One Isolation') {
    throw new Error('User 2 received User 1 settings — isolation violation');
  }
}

// ==================== RUNNER ====================

async function runAll() {
  process.stdout.write('🧪 User Settings Contract Tests\n\n');
  process.stdout.write(`📡 Testing against: ${BASE_URL}\n\n`);

  // Setup
  process.stdout.write('🔐 Setting up auth...\n');
  await setupAuth();
  process.stdout.write(`   User 1: ${ctx.userId}\n`);
  process.stdout.write(`   User 2: ${ctx.userId2}\n\n`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'GET / (read settings)',
      tests: [
        { name: 'happy path (JWT)', fn: testGet_happy },
        { name: 'happy path (API key)', fn: testGet_apiKey },
        { name: 'no auth → 401', fn: testGet_noAuth },
        { name: 'defaults for new user', fn: testGet_defaultsForNewUser },
      ],
    },
    {
      name: 'PUT / (full upsert)',
      tests: [
        { name: 'happy path', fn: testPut_happy },
        { name: 'no auth → 401', fn: testPut_noAuth },
        { name: 'empty body (all optional)', fn: testPut_emptyBody },
        { name: 'bad input — systemName too long → 400', fn: testPut_badInput_systemNameTooLong },
        {
          name: 'bad input — profilePicture too long → 400',
          fn: testPut_badInput_profilePictureTooLong,
        },
        {
          name: 'bad input — customSystemPrompt too long → 400',
          fn: testPut_badInput_customSystemPromptTooLong,
        },
        { name: 'bad input — invalid field type → 400', fn: testPut_badInput_invalidFieldType },
        { name: 'nullable fields set to null', fn: testPut_nullableFields },
        { name: 'upsert creates record for new user', fn: testPut_verifyUpsertCreatesRecord },
      ],
    },
    {
      name: 'PATCH / (partial update)',
      tests: [
        { name: 'happy path', fn: testPatch_happy },
        { name: 'no auth → 401', fn: testPatch_noAuth },
        {
          name: 'partial update preserves other fields',
          fn: testPatch_partialUpdatePreservesOtherFields,
        },
        { name: 'bad input — systemName too long → 400', fn: testPatch_badInput_systemNameTooLong },
        { name: 'bad input — invalid field type → 400', fn: testPatch_badInput_invalidFieldType },
        { name: 'empty body (no-op update)', fn: testPatch_emptyBody },
        { name: 'nullable fields set to null', fn: testPatch_nullableFields },
      ],
    },
    {
      name: 'Cross-endpoint consistency',
      tests: [
        { name: 'GET reflects PUT', fn: testGetReflectsPut },
        { name: 'GET reflects PATCH', fn: testGetReflectsPatch },
        { name: 'user isolation — User 2 cannot see User 1 data', fn: testUserIsolation },
      ],
    },
  ];

  const allResults: TestResult[] = [];

  for (const group of groups) {
    process.stdout.write(`\n📋 ${group.name}\n`);
    for (const test of group.tests) {
      const result = await runTest(`${group.name} — ${test.name}`, test.fn);
      allResults.push(result);
      const icon = result.passed ? '  ✅' : '  ❌';
      process.stdout.write(
        `${icon} ${test.name}${result.passed ? '' : ` — ${result.error}`} (${result.duration}ms)\n`
      );
    }
  }

  // Summary
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  process.stdout.write('\n' + '='.repeat(50) + '\n');
  process.stdout.write(
    `\n📊 Results: ${passed} passed, ${failed} failed, ${allResults.length} total\n`
  );

  if (failed > 0) {
    process.stdout.write('\n❌ FAILURES:\n');
    allResults
      .filter((r) => !r.passed)
      .forEach((r) => process.stdout.write(`   • ${r.name}: ${r.error}\n`));
    process.exit(1);
  }

  process.stdout.write('\n✅ ALL CONTRACT TESTS PASSED\n\n');
  process.exit(0);
}

runAll().catch((error) => {
  process.stderr.write(
    `\n💥 Black-box test suite crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
