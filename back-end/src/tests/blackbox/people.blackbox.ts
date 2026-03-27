#!/usr/bin/env tsx
/**
 * Black-box tests for /api/people
 *
 * Tests the HTTP contract (status codes + response shapes) for all 6 endpoints:
 *   POST /api/people/search    — semantic search for people
 *   POST /api/people           — create person
 *   GET  /api/people           — list people (paginated)
 *   POST /api/people/messages  — get message history for a person
 *   GET  /api/people/messages/recent — get recent messages across all people
 *   GET  /api/people/:id       — get person by ID
 *   DELETE /api/people/:id     — delete person
 *
 * Each endpoint is tested for: happy path, no auth (401), bad input (400),
 * not found (404), wrong user (403) where applicable.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/people.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({
  error: z.string(),
  details: z.string().optional(),
});

const PersonSchema = z.object({
  id: z.string(),
  userId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  age: z.number().nullable(),
  location: z.string().nullable(),
  profession: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  industry: z.string().nullable(),
  email: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  instagramHandle: z.string().nullable(),
  facebookUrl: z.string().nullable(),
  twitterHandle: z.string().nullable(),
  embedding: z.any().nullable(),
  emailAddresses: z.any().nullable(),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
  communicationFrequency: z.string().nullable(),
  contactStatus: z.string().nullable(),
  currentBandwidth: z.string().nullable(),
  estimatedNetWorthUsd: z.number().nullable(),
  estimatedWorldPowerRanking: z.number().nullable(),
  interests: z.any().nullable(),
  networkOrientation: z.string().nullable(),
  notes: z.string().nullable(),
  relation: z.string().nullable(),
  relationshipQuality: z.string().nullable(),
  skills: z.any().nullable(),
  totalOnlineReach: z.number().nullable(),
  messagesExchanged: z.number(),
});

const CreatePersonResponse = z.object({
  person: PersonSchema,
  merged: z.boolean(),
  reason: z.string().optional(),
});

const PaginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

const ListPeopleResponse = z.object({
  people: z.array(PersonSchema),
  pagination: PaginationSchema,
});

const SearchResultItem = z.object({
  id: z.string(),
  similarity: z.number(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
}).passthrough();

const SearchPeopleResponse = z.object({
  query: z.any(),
  results: z.array(SearchResultItem),
  count: z.number(),
});

const MessageItem = z.object({
  channel: z.string(),
  from: z.string(),
  to: z.string(),
  timestamp: z.string(),
  message: z.string(),
});

const PersonMessagesResponse = z.object({
  person: z.any().nullable(),
  messages: z.array(MessageItem),
  count: z.number().optional(),
  message: z.string().optional(),
  multiple_matches: z.boolean().optional(),
  matches: z.array(z.any()).optional(),
});

const RecentMessagesResponse = z.object({
  messages: z.array(MessageItem),
  count: z.number(),
  days: z.number(),
});

const GetPersonResponse = z.object({
  person: PersonSchema,
});

const DeletePersonResponse = z.object({
  message: z.string(),
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
  personId?: string;
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

function apiKeyHeaders(userId?: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-API-Key': API_KEY };
  if (userId) headers['X-User-Id'] = userId;
  return headers;
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

/** Helper: create a person via API key auth (bypasses embedding generation issues with anonymous users) */
async function createTestPerson(userId: string, overrides: Record<string, any> = {}): Promise<string> {
  const personData = {
    first_name: 'ContractTest',
    last_name: 'Person' + Date.now(),
    profession: 'Engineer',
    company: 'TestCorp',
    ...overrides,
  };

  // Use JWT auth from user 1 to create the person
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify(personData),
  });

  // If creation fails (e.g., embedding service down), skip gracefully
  if (res.status !== 201) {
    throw new Error(`Failed to create test person (status ${res.status}): ${JSON.stringify(res.data)}`);
  }

  const data = res.data as { person: { id: string } };
  return data.person.id;
}

// ==================== POST /search — auth required (hybrid) ====================

async function testSearch_happy() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ first_name: 'John' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SearchPeopleResponse, res.data, 'POST /search');
}

async function testSearch_apiKey() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId!),
    body: JSON.stringify({ profession: 'Engineer' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SearchPeopleResponse, res.data, 'POST /search (API key)');
}

async function testSearch_noAuth() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    body: JSON.stringify({ first_name: 'John' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testSearch_emptyCriteria() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /search (400 empty)');
}

async function testSearch_allNullCriteria() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ first_name: '', last_name: null, skills: [] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /search (400 all null)');
}

// ==================== POST / (create) — auth required (JWT only) ====================

async function testCreate_happy() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({
      first_name: 'Jane',
      last_name: 'Doe' + Date.now(),
      profession: 'Designer',
      company: 'DesignCo',
    }),
  });
  assertStatus(res.status, 201, res.data);
  const parsed = assertSchema(CreatePersonResponse, res.data, 'POST /');
  // Store the person ID for later tests
  ctx.personId = parsed.person.id;
}

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    body: JSON.stringify({
      first_name: 'NoAuth',
      last_name: 'Person',
    }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCreate_missingFirstName() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ last_name: 'Only' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing first_name)');
}

async function testCreate_missingLastName() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ first_name: 'Only' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing last_name)');
}

async function testCreate_emptyBody() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 empty body)');
}

// ==================== GET / (list) — auth required (hybrid) ====================

async function testList_happy() {
  const res = await request(`${BASE_URL}/api/people`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET /');
}

async function testList_apiKey() {
  const res = await request(`${BASE_URL}/api/people`, {
    headers: apiKeyHeaders(ctx.userId!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET / (API key)');
}

async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/people`);
  assertStatus(res.status, 401, res.data);
}

async function testList_withPagination() {
  const res = await request(`${BASE_URL}/api/people?page=1&limit=5`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'GET / (paginated)');
  if (parsed.pagination.limit !== 5) {
    throw new Error(`Expected limit 5, got ${parsed.pagination.limit}`);
  }
}

async function testList_withSearch() {
  const res = await request(`${BASE_URL}/api/people?search=Jane`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET / (search)');
}

async function testList_withSort() {
  const res = await request(`${BASE_URL}/api/people?sort=firstName&sortDirection=asc`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET / (sorted)');
}

// ==================== POST /messages — auth required (hybrid) ====================

async function testMessages_happyNoMatch() {
  // Search for a person that doesn't exist — should return empty with message
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ firstName: 'Nonexistent', lastName: 'Nobody' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PersonMessagesResponse, res.data, 'POST /messages (no match)');
  const data = res.data as { person: any; messages: any[]; message: string };
  if (data.person !== null) {
    throw new Error('Expected person to be null for no match');
  }
}

async function testMessages_apiKey() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ user_id: ctx.userId, firstName: 'Jane' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PersonMessagesResponse, res.data, 'POST /messages (API key)');
}

async function testMessages_noAuth() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Jane' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testMessages_noIdentifier() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /messages (400 no identifier)');
}

async function testMessages_emptyIdentifiers() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ phone: '', email: '', firstName: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /messages (400 empty identifiers)');
}

// ==================== GET /messages/recent — auth required (hybrid) ====================

async function testRecentMessages_happy() {
  const res = await request(`${BASE_URL}/api/people/messages/recent`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(RecentMessagesResponse, res.data, 'GET /messages/recent');
}

async function testRecentMessages_apiKey() {
  const res = await request(`${BASE_URL}/api/people/messages/recent`, {
    headers: apiKeyHeaders(ctx.userId!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(RecentMessagesResponse, res.data, 'GET /messages/recent (API key)');
}

async function testRecentMessages_noAuth() {
  const res = await request(`${BASE_URL}/api/people/messages/recent`);
  assertStatus(res.status, 401, res.data);
}

async function testRecentMessages_withParams() {
  const res = await request(`${BASE_URL}/api/people/messages/recent?limit=10&days=7`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'GET /messages/recent (params)');
  if (parsed.days !== 7) {
    throw new Error(`Expected days=7, got ${parsed.days}`);
  }
}

async function testRecentMessages_daysClamped() {
  // days > 30 should be clamped to 30
  const res = await request(`${BASE_URL}/api/people/messages/recent?days=100`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'GET /messages/recent (days clamped)');
  if (parsed.days !== 30) {
    throw new Error(`Expected days to be clamped to 30, got ${parsed.days}`);
  }
}

// ==================== GET /:id — auth required (JWT only) ====================

async function testGetById_happy() {
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GetPersonResponse, res.data, 'GET /:id');
}

async function testGetById_noAuth() {
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`);
  assertStatus(res.status, 401, res.data);
}

async function testGetById_notFound() {
  const res = await request(`${BASE_URL}/api/people/${FAKE_UUID}`, {
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:id (404)');
}

async function testGetById_wrongUser() {
  // User 2 tries to access user 1's person
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  // Route uses userId filter in where clause, so wrong user gets 404 (not 403)
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:id (wrong user → 404)');
}

// ==================== DELETE /:id — auth required (JWT only) ====================

async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`, {
    method: 'DELETE',
  });
  assertStatus(res.status, 401, res.data);
}

async function testDelete_notFound() {
  const res = await request(`${BASE_URL}/api/people/${FAKE_UUID}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'DELETE /:id (404)');
}

async function testDelete_wrongUser() {
  // User 2 tries to delete user 1's person
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken2!),
  });
  // Route uses userId filter in where clause, so wrong user gets 404 (not 403)
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'DELETE /:id (wrong user → 404)');
}

async function testDelete_happy() {
  // Create a disposable person for deletion (so we don't destroy ctx.personId)
  let disposableId: string;
  try {
    disposableId = await createTestPerson(ctx.userId!);
  } catch {
    // If person creation fails (embedding service), use ctx.personId as last resort
    // and skip the GET /:id tests that depend on it
    disposableId = ctx.personId!;
  }

  const res = await request(`${BASE_URL}/api/people/${disposableId}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(DeletePersonResponse, res.data, 'DELETE /:id');
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('🧪 People Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  // Setup
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User 1: ${ctx.userId}`);
  console.log(`   User 2: ${ctx.userId2}\n`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'POST /search',
      tests: [
        { name: 'happy path (JWT)', fn: testSearch_happy },
        { name: 'happy path (API key)', fn: testSearch_apiKey },
        { name: 'no auth → 401', fn: testSearch_noAuth },
        { name: 'empty criteria → 400', fn: testSearch_emptyCriteria },
        { name: 'all null/empty criteria → 400', fn: testSearch_allNullCriteria },
      ],
    },
    {
      name: 'POST / (create)',
      tests: [
        { name: 'happy path', fn: testCreate_happy },
        { name: 'no auth → 401', fn: testCreate_noAuth },
        { name: 'missing first_name → 400', fn: testCreate_missingFirstName },
        { name: 'missing last_name → 400', fn: testCreate_missingLastName },
        { name: 'empty body → 400', fn: testCreate_emptyBody },
      ],
    },
    {
      name: 'GET / (list)',
      tests: [
        { name: 'happy path (JWT)', fn: testList_happy },
        { name: 'happy path (API key)', fn: testList_apiKey },
        { name: 'no auth → 401', fn: testList_noAuth },
        { name: 'with pagination', fn: testList_withPagination },
        { name: 'with search', fn: testList_withSearch },
        { name: 'with sort', fn: testList_withSort },
      ],
    },
    {
      name: 'POST /messages',
      tests: [
        { name: 'no match returns empty', fn: testMessages_happyNoMatch },
        { name: 'API key auth', fn: testMessages_apiKey },
        { name: 'no auth → 401', fn: testMessages_noAuth },
        { name: 'no identifier → 400', fn: testMessages_noIdentifier },
        { name: 'empty identifiers → 400', fn: testMessages_emptyIdentifiers },
      ],
    },
    {
      name: 'GET /messages/recent',
      tests: [
        { name: 'happy path (JWT)', fn: testRecentMessages_happy },
        { name: 'happy path (API key)', fn: testRecentMessages_apiKey },
        { name: 'no auth → 401', fn: testRecentMessages_noAuth },
        { name: 'with limit and days params', fn: testRecentMessages_withParams },
        { name: 'days > 30 clamped to 30', fn: testRecentMessages_daysClamped },
      ],
    },
    {
      name: 'GET /:id',
      tests: [
        { name: 'happy path', fn: testGetById_happy },
        { name: 'no auth → 401', fn: testGetById_noAuth },
        { name: 'not found → 404', fn: testGetById_notFound },
        { name: 'wrong user → 404', fn: testGetById_wrongUser },
      ],
    },
    {
      name: 'DELETE /:id',
      tests: [
        { name: 'no auth → 401', fn: testDelete_noAuth },
        { name: 'not found → 404', fn: testDelete_notFound },
        { name: 'wrong user → 404', fn: testDelete_wrongUser },
        { name: 'happy path', fn: testDelete_happy },
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
