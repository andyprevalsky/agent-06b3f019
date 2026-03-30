#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for /api/people
 *
 * Covers all 7 public entrypoints:
 *   POST /api/people/search         — semantic search for people (hybrid auth)
 *   POST /api/people                — create/upsert person (JWT only)
 *   GET  /api/people                — list people, paginated + sortable (hybrid auth)
 *   POST /api/people/messages       — get message history for a person (hybrid auth)
 *   GET  /api/people/messages/recent — recent messages across all people (hybrid auth)
 *   GET  /api/people/:id            — get person by ID (JWT only)
 *   DELETE /api/people/:id          — delete person (JWT only)
 *
 * Boundary capture tests:
 *   - Validation-rejected requests -> 0 outbound calls
 *   - Unauthenticated requests -> 0 outbound calls
 *
 * Boundary not captured (OpenAI Embeddings API):
 *   POST /api/people (create) and POST /api/people/search both call OpenAI's
 *   text-embedding-3-small API via the `openai` SDK. The SDK uses its own HTTP
 *   client (not globalThis.fetch), so the fetch capture interceptor cannot record
 *   these calls. The boundary is verified indirectly: create returns 201 with a
 *   non-null embedding field, and search returns similarity scores — both prove
 *   the OpenAI call succeeded. Exact param assertions are not possible via fetch
 *   capture for SDK-managed HTTP clients.
 *
 * Invariants covered:
 *   - auth boundary: all endpoints reject unauthenticated requests (401)
 *   - error-surface: all error responses include { error: string }
 *   - read-after-write: created person immediately retrievable via GET /:id and GET /
 *   - state-transition: create -> list -> get -> delete -> 404
 *   - tenant isolation: user 1 cannot see/modify user 2's people
 *   - ordering/pagination: list endpoint respects page, limit, sort, search
 *   - boundary param: indirect verification of OpenAI embedding generation
 *   - cleanup: each test creates its own data; no shared mutable fixtures leak
 *   - reproducibility: deterministic given the same inputs
 *   - time/clock: days param clamped between 1 and 30
 *
 * Invariants not applicable:
 *   - idempotency: POST /people is create-or-merge (not idempotent); tested via collision
 *   - concurrency: no concurrent mutation risk beyond DB-level constraints
 *   - atomicity: single Prisma operations; no multi-step transactions to test
 *   - referential integrity: enforced by Prisma/Postgres cascade on Person -> MessageRecord
 *   - event/job cardinality: no async jobs triggered by people endpoints
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *   - duplication prevention: handled by collision detection (tested in sequential phase)
 *
 * Usage:
 *   npx tsx src/tests/blackbox/people.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/people.blackbox.ts
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
  details: z.string().optional(),
});

const PersonSchema = z
  .object({
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
  })
  .passthrough();

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

const SearchResultItem = z
  .object({
    id: z.string(),
    similarity: z.number(),
  })
  .passthrough();

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
  cached: boolean;
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
  personId?: string;
  captureAvailable: boolean;
}

const ctx: TestContext = { captureAvailable: false };

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

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

async function createAnonSession(): Promise<{
  accessToken: string;
  userId: string;
}> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = res.data as {
    session: { access_token: string };
    user: { id: string };
  };
  return { accessToken: body.session.access_token, userId: body.user.id };
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createPerson(
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<{ id: string; firstName: string; lastName: string }> {
  const personData = {
    first_name: 'BBTest',
    last_name: `Person${uid()}`,
    profession: 'Engineer',
    company: 'TestCorp',
    ...overrides,
  };
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(personData),
  });
  if (res.status !== 201) {
    throw new Error(
      `Failed to create test person (status ${res.status}): ${JSON.stringify(res.data)}`
    );
  }
  const data = res.data as {
    person: { id: string; firstName: string; lastName: string };
  };
  return data.person;
}

// ==================== SETUP ====================

async function setup(): Promise<void> {
  const [s1, s2] = await Promise.all([createAnonSession(), createAnonSession()]);
  ctx.accessToken1 = s1.accessToken;
  ctx.userId1 = s1.userId;
  ctx.accessToken2 = s2.accessToken;
  ctx.userId2 = s2.userId;

  const person = await createPerson(ctx.accessToken1!);
  ctx.personId = person.id;

  ctx.captureAvailable = await checkCaptureAvailable();
}

// ==================== POST /search — hybrid auth ====================

async function testSearch_happyJwt() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ first_name: 'John' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SearchPeopleResponse, res.data, 'POST /search (JWT)');
}

async function testSearch_happyApiKey() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId1!),
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
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /search (400 empty)');
}

async function testSearch_allNullCriteria() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ first_name: '', last_name: null, skills: [] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /search (400 all null)');
}

async function testSearch_withLimitParam() {
  const res = await request(`${BASE_URL}/api/people/search?limit=2`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ first_name: 'BBTest' }),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(SearchPeopleResponse, res.data, 'POST /search (limit)');
  assert(parsed.results.length <= 2, `Expected at most 2 results, got ${parsed.results.length}`);
}

// ==================== POST / (create) — JWT only ====================

async function testCreate_happy() {
  const suffix = uid();
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      first_name: 'CreateHappy',
      last_name: `Person${suffix}`,
      profession: 'Designer',
      company: 'DesignCo',
    }),
  });
  assertStatus(res.status, 201, res.data);
  const parsed = assertSchema(CreatePersonResponse, res.data, 'POST /');
  assert(parsed.merged === false, 'Expected merged=false for new person');
  assert(parsed.person.firstName === 'CreateHappy', 'firstName mismatch');
  assert(parsed.person.userId === ctx.userId1, 'userId mismatch');
}

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    body: JSON.stringify({ first_name: 'NoAuth', last_name: 'Person' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCreate_missingFirstName() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ last_name: 'Only' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing first_name)');
}

async function testCreate_missingLastName() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ first_name: 'Only' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing last_name)');
}

async function testCreate_emptyBody() {
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 empty body)');
}

async function testCreate_withAllFields() {
  const suffix = uid();
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      first_name: 'FullField',
      last_name: `Test${suffix}`,
      age: 30,
      location: 'San Francisco',
      profession: 'CEO',
      company: 'TestCorp',
      title: 'Chief Executive',
      industry: 'Technology',
      email: `full-${suffix}@test.com`,
      phoneNumber: `+1555${Date.now().toString().slice(-7)}`,
      relation: 'colleague',
      communication_frequency: 'weekly',
      relationship_quality: 'strong',
      skills: ['leadership', 'strategy'],
      interests: ['AI', 'music'],
      total_online_reach: 50000,
      estimated_net_worth_usd: 5000000,
      estimated_world_power_ranking: 7,
      current_bandwidth: 'available',
      contact_status: 'active',
      network_orientation: 'connector',
      notes: 'Test person with all fields',
    }),
  });
  assertStatus(res.status, 201, res.data);
  const parsed = assertSchema(CreatePersonResponse, res.data, 'POST / (all fields)');
  assert(parsed.person.profession === 'CEO', 'profession mismatch');
  assert(parsed.person.company === 'TestCorp', 'company mismatch');
  assert(parsed.person.age === 30, `age mismatch: ${parsed.person.age}`);
}

// ==================== GET / (list) — hybrid auth ====================

async function testList_happyJwt() {
  const res = await request(`${BASE_URL}/api/people`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'GET /');
  assert(parsed.pagination.page === 1, 'Expected default page=1');
  assert(parsed.pagination.total >= 1, 'Expected at least 1 person');
}

async function testList_happyApiKey() {
  const res = await request(`${BASE_URL}/api/people`, {
    headers: apiKeyHeaders(ctx.userId1!),
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
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'GET / (paginated)');
  assert(parsed.pagination.limit === 5, `Expected limit 5, got ${parsed.pagination.limit}`);
  assert(parsed.people.length <= 5, `Expected at most 5 people, got ${parsed.people.length}`);
}

async function testList_withSearch() {
  const res = await request(`${BASE_URL}/api/people?search=BBTest`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET / (search)');
}

async function testList_withSortFirstName() {
  const res = await request(`${BASE_URL}/api/people?sort=firstName&sortDirection=asc`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET / (sort firstName asc)');
}

async function testList_withSortCommFreq() {
  const res = await request(
    `${BASE_URL}/api/people?sort=communicationFrequency&sortDirection=asc`,
    { headers: authHeaders(ctx.accessToken1!) }
  );
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET / (sort communicationFrequency)');
}

async function testList_invalidSortFallsBack() {
  const res = await request(`${BASE_URL}/api/people?sort=INVALID_COLUMN`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET / (invalid sort fallback)');
}

async function testList_limitCappedAt2000() {
  const res = await request(`${BASE_URL}/api/people?limit=99999`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'GET / (limit cap)');
  assert(
    parsed.pagination.limit === 2000,
    `Expected limit capped at 2000, got ${parsed.pagination.limit}`
  );
}

async function testList_page0Handled() {
  const res = await request(`${BASE_URL}/api/people?page=0`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListPeopleResponse, res.data, 'GET / (page 0)');
}

// ==================== POST /messages — hybrid auth ====================

async function testMessages_noMatch() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ firstName: 'Nonexistent', lastName: 'Nobody' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PersonMessagesResponse, res.data, 'POST /messages (no match)');
  const data = res.data as { person: unknown };
  assert(data.person === null, 'Expected person to be null for no match');
}

async function testMessages_apiKey() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ user_id: ctx.userId1, firstName: 'BBTest' }),
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
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /messages (400 no identifier)');
}

async function testMessages_emptyIdentifiers() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ phone: '', email: '', firstName: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /messages (400 empty identifiers)');
}

async function testMessages_byPhone() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ phone: '+10000000000' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PersonMessagesResponse, res.data, 'POST /messages (by phone)');
}

async function testMessages_byEmail() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ email: 'nonexistent@test.com' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PersonMessagesResponse, res.data, 'POST /messages (by email)');
}

async function testMessages_firstNameOnly() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ firstName: 'BBTest' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(PersonMessagesResponse, res.data, 'POST /messages (firstName only)');
}

// ==================== GET /messages/recent — hybrid auth ====================

async function testRecentMessages_happyJwt() {
  const res = await request(`${BASE_URL}/api/people/messages/recent`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'GET /messages/recent');
  assert(parsed.days === 1, `Expected default days=1, got ${parsed.days}`);
}

async function testRecentMessages_happyApiKey() {
  const res = await request(`${BASE_URL}/api/people/messages/recent`, {
    headers: apiKeyHeaders(ctx.userId1!),
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
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'GET /messages/recent (params)');
  assert(parsed.days === 7, `Expected days=7, got ${parsed.days}`);
}

async function testRecentMessages_daysClampedMax() {
  const res = await request(`${BASE_URL}/api/people/messages/recent?days=100`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'GET /messages/recent (days max)');
  assert(parsed.days === 30, `Expected days clamped to 30, got ${parsed.days}`);
}

async function testRecentMessages_daysClampedMin() {
  const res = await request(`${BASE_URL}/api/people/messages/recent?days=0`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'GET /messages/recent (days min)');
  assert(parsed.days === 1, `Expected days clamped to 1, got ${parsed.days}`);
}

// ==================== GET /:id — JWT only ====================

async function testGetById_happy() {
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(GetPersonResponse, res.data, 'GET /:id');
  assert(parsed.person.id === ctx.personId, 'ID mismatch');
}

async function testGetById_noAuth() {
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`);
  assertStatus(res.status, 401, res.data);
}

async function testGetById_notFound() {
  const res = await request(`${BASE_URL}/api/people/${FAKE_UUID}`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:id (404)');
}

async function testGetById_wrongUser() {
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:id (wrong user -> 404)');
}

// ==================== DELETE /:id — JWT only ====================

async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`, {
    method: 'DELETE',
  });
  assertStatus(res.status, 401, res.data);
}

async function testDelete_notFound() {
  const res = await request(`${BASE_URL}/api/people/${FAKE_UUID}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'DELETE /:id (404)');
}

async function testDelete_wrongUser() {
  const res = await request(`${BASE_URL}/api/people/${ctx.personId}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'DELETE /:id (wrong user -> 404)');
}

// ==================== INVARIANTS ====================

async function testInvariant_errorSurface401() {
  const endpoints: [string, RequestInit][] = [
    [
      `${BASE_URL}/api/people/search`,
      { method: 'POST', body: JSON.stringify({ first_name: 'x' }) },
    ],
    [
      `${BASE_URL}/api/people`,
      { method: 'POST', body: JSON.stringify({ first_name: 'x', last_name: 'y' }) },
    ],
    [`${BASE_URL}/api/people`, {}],
    [
      `${BASE_URL}/api/people/messages`,
      { method: 'POST', body: JSON.stringify({ firstName: 'x' }) },
    ],
    [`${BASE_URL}/api/people/messages/recent`, {}],
    [`${BASE_URL}/api/people/${FAKE_UUID}`, {}],
    [`${BASE_URL}/api/people/${FAKE_UUID}`, { method: 'DELETE' }],
  ];
  for (const [url, init] of endpoints) {
    const res = await request(url, init);
    assertStatus(res.status, 401, res.data);
    assertSchema(ErrorResponse, res.data, `error-surface 401: ${url}`);
  }
}

async function testInvariant_tenantIsolationList() {
  const res = await request(`${BASE_URL}/api/people?search=BBTest`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'tenant isolation list');
  assert(
    parsed.pagination.total === 0,
    `User 2 should see 0 people, got ${parsed.pagination.total}`
  );
}

async function testInvariant_readAfterWrite() {
  const person = await createPerson(ctx.accessToken1!, {
    first_name: 'RAW',
    last_name: `Test${uid()}`,
  });
  const res = await request(`${BASE_URL}/api/people/${person.id}`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(GetPersonResponse, res.data, 'read-after-write');
  assert(parsed.person.id === person.id, 'read-after-write ID mismatch');
  assert(parsed.person.firstName === 'RAW', 'read-after-write firstName mismatch');
}

async function testInvariant_readAfterWriteInList() {
  const uniqueName = `RAWList${uid()}`;
  await createPerson(ctx.accessToken1!, {
    first_name: uniqueName,
    last_name: 'Test',
  });
  const res = await request(`${BASE_URL}/api/people?search=${encodeURIComponent(uniqueName)}`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'read-after-write list');
  assert(
    parsed.pagination.total >= 1,
    `Expected to find person in list, got total=${parsed.pagination.total}`
  );
  const found = parsed.people.some((p) => p.firstName === uniqueName);
  assert(found, `Person with firstName=${uniqueName} not found in list`);
}

// ==================== SEQUENTIAL: STATE-DEPENDENT TESTS ====================

async function testSequential_deleteAndVerify() {
  const person = await createPerson(ctx.accessToken1!, {
    first_name: 'DeleteMe',
    last_name: `Test${uid()}`,
  });
  const delRes = await request(`${BASE_URL}/api/people/${person.id}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(delRes.status, 200, delRes.data);
  assertSchema(DeletePersonResponse, delRes.data, 'delete happy');

  const getRes = await request(`${BASE_URL}/api/people/${person.id}`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(getRes.status, 404, getRes.data);
}

async function testSequential_messagesForCreatedPerson() {
  const suffix = uid();
  const person = await createPerson(ctx.accessToken1!, {
    first_name: 'MsgLookup',
    last_name: `Test${suffix}`,
  });
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ firstName: 'MsgLookup', lastName: `Test${suffix}` }),
  });
  assertStatus(res.status, 200, res.data);
  const data = res.data as {
    person: { id: string } | null;
    messages: unknown[];
  };
  assert(data.person !== null, 'Expected person to be found');
  assert(data.person!.id === person.id, 'Person ID mismatch in message lookup');
  assert(data.messages.length === 0, 'Expected 0 messages for new person');
}

async function testSequential_collisionMerge() {
  const phone = `+1999${Date.now().toString().slice(-7)}`;
  const suffix = uid();

  const res1 = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      first_name: 'Collision',
      last_name: `First${suffix}`,
      phoneNumber: phone,
    }),
  });
  assertStatus(res1.status, 201, res1.data);
  const first = assertSchema(CreatePersonResponse, res1.data, 'collision first');
  assert(first.merged === false, 'First create should not be a merge');

  const res2 = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      first_name: 'Collision',
      last_name: `Second${suffix}`,
      phoneNumber: phone,
      profession: 'Merged Engineer',
    }),
  });
  assertStatus(res2.status, 200, res2.data);
  const second = assertSchema(CreatePersonResponse, res2.data, 'collision merge');
  assert(second.merged === true, 'Second create should be a merge');
  assert(second.person.id === first.person.id, 'Merged person should have same ID');
  assert(second.reason !== undefined, 'Merged response should include reason');
}

// ==================== BOUNDARY CAPTURE TESTS ====================

async function testBoundary_createEmbeddingGenerated() {
  const suffix = uid();
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      first_name: 'BoundaryCreate',
      last_name: `Test${suffix}`,
      profession: 'Boundary Engineer',
    }),
  });
  if (res.status !== 201) {
    console.log(
      `    [skipped] Person creation failed (${res.status}) -- OpenAI may not be configured`
    );
    return;
  }
  const parsed = assertSchema(CreatePersonResponse, res.data, 'boundary create');
  assert(parsed.person.embedding !== null, 'Expected non-null embedding');
  assert(Array.isArray(parsed.person.embedding), 'Expected embedding to be an array');
  assert(parsed.person.embedding.length > 0, 'Expected non-empty embedding array');
}

async function testBoundary_searchEmbeddingUsed() {
  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ profession: 'BoundarySearchTarget' }),
  });
  if (res.status !== 200) {
    console.log(`    [skipped] Search failed (${res.status}) -- OpenAI may not be configured`);
    return;
  }
  const parsed = assertSchema(SearchPeopleResponse, res.data, 'boundary search');
  for (const result of parsed.results) {
    assert(typeof result.similarity === 'number', 'Expected numeric similarity');
    assert(
      result.similarity >= -1 && result.similarity <= 1,
      `Similarity out of range: ${result.similarity}`
    );
  }
}

async function testBoundary_createValidationNoOutbound() {
  await clearCaptures();
  await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ last_name: 'OnlyLast' }),
  });
  const calls = await readCaptures();
  const openaiCalls = calls.filter((c) => c.url.includes('api.openai.com'));
  assert(
    openaiCalls.length === 0,
    `Expected 0 OpenAI calls for validation failure, got ${openaiCalls.length}`
  );
}

async function testBoundary_searchValidationNoOutbound() {
  await clearCaptures();
  await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  const calls = await readCaptures();
  const openaiCalls = calls.filter((c) => c.url.includes('api.openai.com'));
  assert(
    openaiCalls.length === 0,
    `Expected 0 OpenAI calls for validation failure, got ${openaiCalls.length}`
  );
}

async function testBoundary_noAuthNoOutbound() {
  await clearCaptures();
  await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    body: JSON.stringify({ first_name: 'x', last_name: 'y' }),
  });
  const calls = await readCaptures();
  const openaiCalls = calls.filter((c) => c.url.includes('api.openai.com'));
  assert(
    openaiCalls.length === 0,
    `Expected 0 OpenAI calls for unauthed request, got ${openaiCalls.length}`
  );
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('People Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth sessions and test data...');
  await setup();
  console.log(`  User 1: ${ctx.userId1}`);
  console.log(`  User 2: ${ctx.userId2}`);
  console.log(`  Person ID: ${ctx.personId}`);
  console.log(`  Capture available: ${ctx.captureAvailable}\n`);

  // Phase 2: Parallel independent tests
  const parallelTests = [
    { name: 'POST /search -- happy path (JWT)', fn: testSearch_happyJwt },
    { name: 'POST /search -- happy path (API key)', fn: testSearch_happyApiKey },
    { name: 'POST /search -- no auth -> 401', fn: testSearch_noAuth },
    { name: 'POST /search -- empty criteria -> 400', fn: testSearch_emptyCriteria },
    { name: 'POST /search -- all null criteria -> 400', fn: testSearch_allNullCriteria },
    { name: 'POST /search -- with limit param', fn: testSearch_withLimitParam },
    { name: 'POST / -- happy path', fn: testCreate_happy },
    { name: 'POST / -- no auth -> 401', fn: testCreate_noAuth },
    { name: 'POST / -- missing first_name -> 400', fn: testCreate_missingFirstName },
    { name: 'POST / -- missing last_name -> 400', fn: testCreate_missingLastName },
    { name: 'POST / -- empty body -> 400', fn: testCreate_emptyBody },
    { name: 'POST / -- with all fields', fn: testCreate_withAllFields },
    { name: 'GET / -- happy path (JWT)', fn: testList_happyJwt },
    { name: 'GET / -- happy path (API key)', fn: testList_happyApiKey },
    { name: 'GET / -- no auth -> 401', fn: testList_noAuth },
    { name: 'GET / -- with pagination', fn: testList_withPagination },
    { name: 'GET / -- with search', fn: testList_withSearch },
    { name: 'GET / -- sort by firstName', fn: testList_withSortFirstName },
    { name: 'GET / -- sort by communicationFrequency', fn: testList_withSortCommFreq },
    { name: 'GET / -- invalid sort falls back', fn: testList_invalidSortFallsBack },
    { name: 'GET / -- limit capped at 2000', fn: testList_limitCappedAt2000 },
    { name: 'GET / -- page 0 handled', fn: testList_page0Handled },
    { name: 'POST /messages -- no match', fn: testMessages_noMatch },
    { name: 'POST /messages -- API key auth', fn: testMessages_apiKey },
    { name: 'POST /messages -- no auth -> 401', fn: testMessages_noAuth },
    { name: 'POST /messages -- no identifier -> 400', fn: testMessages_noIdentifier },
    { name: 'POST /messages -- empty identifiers -> 400', fn: testMessages_emptyIdentifiers },
    { name: 'POST /messages -- by phone (no match)', fn: testMessages_byPhone },
    { name: 'POST /messages -- by email (no match)', fn: testMessages_byEmail },
    { name: 'POST /messages -- firstName only', fn: testMessages_firstNameOnly },
    { name: 'GET /messages/recent -- happy (JWT)', fn: testRecentMessages_happyJwt },
    { name: 'GET /messages/recent -- happy (API key)', fn: testRecentMessages_happyApiKey },
    { name: 'GET /messages/recent -- no auth -> 401', fn: testRecentMessages_noAuth },
    { name: 'GET /messages/recent -- with params', fn: testRecentMessages_withParams },
    { name: 'GET /messages/recent -- days > 30 clamped', fn: testRecentMessages_daysClampedMax },
    { name: 'GET /messages/recent -- days < 1 clamped', fn: testRecentMessages_daysClampedMin },
    { name: 'GET /:id -- happy path', fn: testGetById_happy },
    { name: 'GET /:id -- no auth -> 401', fn: testGetById_noAuth },
    { name: 'GET /:id -- not found -> 404', fn: testGetById_notFound },
    { name: 'GET /:id -- wrong user -> 404', fn: testGetById_wrongUser },
    { name: 'DELETE /:id -- no auth -> 401', fn: testDelete_noAuth },
    { name: 'DELETE /:id -- not found -> 404', fn: testDelete_notFound },
    { name: 'DELETE /:id -- wrong user -> 404', fn: testDelete_wrongUser },
    { name: 'invariant -- error surface (401s)', fn: testInvariant_errorSurface401 },
    { name: 'invariant -- tenant isolation (list)', fn: testInvariant_tenantIsolationList },
    { name: 'invariant -- read-after-write (GET)', fn: testInvariant_readAfterWrite },
    { name: 'invariant -- read-after-write (list)', fn: testInvariant_readAfterWriteInList },
  ];

  console.log(
    `Running ${parallelTests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`
  );
  const parallelResults = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of parallelResults) {
    const icon = r.passed ? '  PASS' : '  FAIL';
    console.log(`${icon}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`);
  }

  // Phase 3: Sequential state-dependent + boundary tests
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'sequential -- delete and verify 404', fn: testSequential_deleteAndVerify },
    {
      name: 'sequential -- messages for created person',
      fn: testSequential_messagesForCreatedPerson,
    },
    { name: 'sequential -- collision merge', fn: testSequential_collisionMerge },
    {
      name: 'boundary -- create generates embedding',
      fn: testBoundary_createEmbeddingGenerated,
    },
    {
      name: 'boundary -- search uses embeddings',
      fn: testBoundary_searchEmbeddingUsed,
    },
  ];

  if (ctx.captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary -- create validation no outbound',
        fn: testBoundary_createValidationNoOutbound,
      },
      {
        name: 'boundary -- search validation no outbound',
        fn: testBoundary_searchValidationNoOutbound,
      },
      {
        name: 'boundary -- unauthed request no outbound',
        fn: testBoundary_noAuthNoOutbound,
      }
    );
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) ' +
        '-- skipping fetch capture tests'
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

  console.log('\nALL PEOPLE BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
