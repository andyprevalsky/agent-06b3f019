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
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');

// Direct Prisma client for seeding MessageRecord rows that no public API
// can produce. Reuses the same DATABASE_URL the test backend uses, so
// writes are immediately visible to the API under test.
const prisma = new PrismaClient();

// Fast-forward cache directory for seeding deterministic OpenAI embedding
// responses (mirrors auth.blackbox.ts's seeding pattern). Resolved from this
// file's location so it works whether the test runs via the runner or directly.
const FF_CACHE_DIR = resolvePath(
  __dirname,
  '../../../../.context/fast-forward-cache/outbound-fetch'
);

// ---- OpenAI embedding cache seeding -----------------------------------------
// providers/embeddings.ts now routes through globalThis.fetch (so fetchCapture
// can intercept), and the OpenAI SDK serializes embedding requests as
// JSON.stringify(body, null, 2) with encoding_format=base64. We pre-seed the
// FF cache with a fixed embedding for a known input so create/search paths
// don't make real OpenAI calls (which return 429 quota-exceeded in CI).

interface SerializedFFResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
}

function ffCacheKey(url: string, method: string, body: string | null): string {
  return `call:${JSON.stringify([url, method, body])}`;
}

function ffCacheFilePath(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return resolvePath(FF_CACHE_DIR, `${hash}.json`);
}

function seedFastForward(
  url: string,
  method: string,
  body: string | null,
  response: SerializedFFResponse
): void {
  if (!existsSync(FF_CACHE_DIR)) {
    mkdirSync(FF_CACHE_DIR, { recursive: true });
  }
  const key = ffCacheKey(url, method, body);
  const entry = {
    key,
    value: { __ff_promise_result: true, value: response },
    timestamp: Date.now(),
  };
  writeFileSync(ffCacheFilePath(key), JSON.stringify(entry, null, 2), 'utf8');
}

/**
 * Mirror of providers/embeddings.ts:buildPersonEmbeddingText so we can compute
 * the exact input text the SDK will send for a given signal set, then seed
 * the cache for that text. Keep these two in sync — divergence breaks tests.
 */
function buildPersonEmbeddingTextLocal(signals: Record<string, unknown>): string {
  const parts: string[] = [];
  if (signals.first_name || signals.last_name) {
    const name = [signals.first_name, signals.last_name].filter(Boolean).join(' ');
    parts.push(`Name: ${name}`);
  }
  if (signals.age) parts.push(`Age: ${signals.age}`);
  if (signals.location) parts.push(`Location: ${signals.location}`);
  if (signals.profession) parts.push(`Profession: ${signals.profession}`);
  if (signals.company) parts.push(`Company: ${signals.company}`);
  if (signals.title) parts.push(`Title: ${signals.title}`);
  if (signals.industry) parts.push(`Industry: ${signals.industry}`);
  if (signals.relation) parts.push(`Relationship: ${signals.relation}`);
  if (signals.communication_frequency)
    parts.push(`Communication frequency: ${signals.communication_frequency}`);
  if (signals.relationship_quality)
    parts.push(`Relationship quality: ${signals.relationship_quality}`);
  if (Array.isArray(signals.skills) && signals.skills.length > 0) {
    parts.push(`Skills: ${(signals.skills as string[]).join(', ')}`);
  }
  if (Array.isArray(signals.interests) && signals.interests.length > 0) {
    parts.push(`Interests: ${(signals.interests as string[]).join(', ')}`);
  }
  if (signals.total_online_reach) {
    parts.push(
      `Online reach: ${(signals.total_online_reach as number).toLocaleString()} followers`
    );
  }
  if (signals.estimated_net_worth_usd) {
    const netWorthFormatted = `$${((signals.estimated_net_worth_usd as number) / 1000000).toFixed(1)}M`;
    parts.push(`Estimated net worth: ${netWorthFormatted}`);
  }
  if (signals.estimated_world_power_ranking) {
    parts.push(`World power ranking: ${signals.estimated_world_power_ranking}/10`);
  }
  if (signals.current_bandwidth) parts.push(`Current bandwidth: ${signals.current_bandwidth}`);
  if (signals.contact_status) parts.push(`Contact status: ${signals.contact_status}`);
  if (signals.network_orientation)
    parts.push(`Network orientation: ${signals.network_orientation}`);
  if (signals.notes) parts.push(`Notes: ${signals.notes}`);
  return parts.join('. ');
}

/**
 * Encode a float32 vector as base64 — the format the OpenAI SDK expects when
 * encoding_format=base64 (default since v4 for performance, see openai-node#1312).
 */
function float32ToBase64(vec: number[]): string {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf.toString('base64');
}

/**
 * Seed an OpenAI embedding response for a given input text. Returns the
 * embedding the SDK will receive (after base64 → float32 round-trip).
 *
 * The cache key includes the exact request body the SDK sends:
 *   {model, input, encoding_format}, JSON.stringify(_, null, 2)
 */
function seedOpenAIEmbedding(input: string, embedding: number[]): void {
  const body = JSON.stringify(
    {
      model: 'text-embedding-3-small',
      input,
      encoding_format: 'base64',
    },
    null,
    2
  );
  const responseBody = JSON.stringify({
    object: 'list',
    model: 'text-embedding-3-small',
    data: [{ object: 'embedding', index: 0, embedding: float32ToBase64(embedding) }],
    usage: { prompt_tokens: 8, total_tokens: 8 },
  });
  seedFastForward('https://api.openai.com/v1/embeddings', 'POST', body, {
    status: 200,
    statusText: 'OK',
    body: responseBody,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Seed an embedding for a person-shaped signals object — convenience wrapper
 * around seedOpenAIEmbedding that derives the input text from the signals.
 */
function seedEmbeddingForSignals(signals: Record<string, unknown>, embedding: number[]): void {
  const input = buildPersonEmbeddingTextLocal(signals);
  seedOpenAIEmbedding(input, embedding);
}

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

/**
 * Seed a MessageRecord row directly via Prisma. No public API exists for this
 * (messages enter the system via integration parsers like Gmail/iMessage that
 * can't be exercised in a blackbox test). Writes hit the same Postgres the
 * test backend reads from, so they're visible to subsequent API calls.
 */
async function seedMessage(
  personId: string,
  overrides: Partial<{
    channel: string;
    from: string;
    to: string;
    timestamp: Date;
    message: string;
    externalId: string | null;
  }> = {}
): Promise<void> {
  await prisma.messageRecord.create({
    data: {
      personId,
      channel: (overrides.channel as 'IMESSAGE' | 'EMAIL') ?? 'IMESSAGE',
      from: overrides.from ?? '+15555550100',
      to: overrides.to ?? '+15555550101',
      timestamp: overrides.timestamp ?? new Date(),
      message: overrides.message ?? 'Test message body',
      externalId: overrides.externalId ?? `test-${uid()}`,
    },
  });
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

// Covers service.messages.ts:103-107 (formatMessages records map),
// 181-186 (return path with messages), and the messageRecords destructure
// path in getPersonMessages. Seeds rows directly via Prisma since no public
// API can produce MessageRecord rows.
async function testSequential_messagesReturnRecords() {
  const suffix = uid();
  const phone = `+1888${Date.now().toString().slice(-7)}`;
  const person = await createPerson(ctx.accessToken1!, {
    first_name: 'WithMsgs',
    last_name: `Person${suffix}`,
    phoneNumber: phone,
  });

  // Seed three messages on different timestamps to verify ordering and limit.
  const baseTime = Date.now();
  await seedMessage(person.id, {
    channel: 'IMESSAGE',
    from: phone,
    to: '+15555550101',
    timestamp: new Date(baseTime - 30_000),
    message: 'Older message',
  });
  await seedMessage(person.id, {
    channel: 'IMESSAGE',
    from: '+15555550101',
    to: phone,
    timestamp: new Date(baseTime - 15_000),
    message: 'Middle message',
  });
  await seedMessage(person.id, {
    channel: 'EMAIL',
    from: phone,
    to: '+15555550101',
    timestamp: new Date(baseTime),
    message: 'Newest message',
  });

  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ phone }),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(PersonMessagesResponse, res.data, 'messages with records');
  assert(parsed.person !== null, 'Expected person to be returned');
  assert(parsed.messages.length === 3, `Expected 3 messages, got ${parsed.messages.length}`);
  assert(parsed.count === 3, `Expected count=3, got ${parsed.count}`);
  // Newest first (DESC order from repo.findPersonWithMessages)
  assert(
    parsed.messages[0].message === 'Newest message',
    `Expected newest first, got "${parsed.messages[0].message}"`
  );
  assert(
    parsed.messages[2].message === 'Older message',
    `Expected oldest last, got "${parsed.messages[2].message}"`
  );
  // ISO timestamps round-trip through formatMessages (line 106 — record.timestamp.toISOString())
  assert(
    typeof parsed.messages[0].timestamp === 'string' && parsed.messages[0].timestamp.includes('T'),
    `Expected ISO timestamp, got "${parsed.messages[0].timestamp}"`
  );
  // Channel preserved through formatMessages map (line 103)
  assert(
    parsed.messages[0].channel === 'EMAIL',
    `Expected EMAIL channel, got "${parsed.messages[0].channel}"`
  );
}

// Covers service.messages.ts:154-155 (message_limit path with valid number)
async function testSequential_messagesRespectsLimit() {
  const suffix = uid();
  const phone = `+1887${Date.now().toString().slice(-7)}`;
  const person = await createPerson(ctx.accessToken1!, {
    first_name: 'LimitMsgs',
    last_name: `Person${suffix}`,
    phoneNumber: phone,
  });

  for (let i = 0; i < 5; i++) {
    await seedMessage(person.id, {
      from: phone,
      to: '+15555550101',
      timestamp: new Date(Date.now() - (5 - i) * 1000),
      message: `Message ${i}`,
    });
  }

  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ phone, message_limit: 2 }),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(PersonMessagesResponse, res.data, 'messages with limit');
  assert(parsed.messages.length === 2, `Expected 2 messages, got ${parsed.messages.length}`);
}

// Covers service.messages.ts:135-152 (multiple_matches path) — two people
// with the same first/last name causes findMatchingPeople to return >1.
async function testSequential_messagesMultipleMatches() {
  const sharedFirst = `Multi${uid()}`;
  const sharedLast = 'Match';
  const personA = await createPerson(ctx.accessToken1!, {
    first_name: sharedFirst,
    last_name: sharedLast,
    phoneNumber: `+1700${Date.now().toString().slice(-7)}`,
  });
  // Wait a moment so the second create avoids the collision merge path.
  const personB = await createPerson(ctx.accessToken1!, {
    first_name: sharedFirst,
    last_name: sharedLast,
    phoneNumber: `+1701${Date.now().toString().slice(-7)}`,
  });
  assert(personA.id !== personB.id, 'Expected two distinct people for multi-match');

  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ firstName: sharedFirst, lastName: sharedLast }),
  });
  assertStatus(res.status, 200, res.data);
  const data = res.data as {
    person: unknown;
    messages: unknown[];
    multiple_matches?: boolean;
    matches?: Array<{ id: string }>;
    message?: string;
  };
  assert(data.person === null, 'Expected person=null on multi-match');
  assert(data.multiple_matches === true, 'Expected multiple_matches=true');
  assert(Array.isArray(data.matches), 'Expected matches array');
  const matchIds = data.matches!.map((m) => m.id);
  assert(matchIds.includes(personA.id), 'Expected personA in matches');
  assert(matchIds.includes(personB.id), 'Expected personB in matches');
  assert(
    typeof data.message === 'string' && data.message.includes('name'),
    `Expected idType=name in message, got "${data.message}"`
  );
}

// Covers service.messages.ts:136 idType branch — multiple matches resolved via
// email (vs name). Two separate people sharing the same email.
async function testSequential_messagesMultipleMatchesByEmail() {
  const sharedEmail = `multi-${uid()}@bbtest.example`;
  const personA = await createPerson(ctx.accessToken1!, {
    first_name: `EmailMatchA${uid()}`,
    last_name: 'Test',
    email: sharedEmail,
  });
  // Force a second person with the same email by writing directly through Prisma
  // (the public API would merge via collision detection on email).
  const personB = await prisma.person.create({
    data: {
      userId: ctx.userId1!,
      firstName: `EmailMatchB${uid()}`,
      lastName: 'Test',
      email: sharedEmail,
      skills: [],
      interests: [],
      emailAddresses: [],
    },
  });
  assert(personA.id !== personB.id, 'Expected two distinct people');

  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ email: sharedEmail }),
  });
  assertStatus(res.status, 200, res.data);
  const data = res.data as { multiple_matches?: boolean; message?: string };
  assert(data.multiple_matches === true, 'Expected multiple_matches=true');
  assert(
    typeof data.message === 'string' && data.message.includes('email'),
    `Expected idType=email in message, got "${data.message}"`
  );
}

// Covers service.messages.ts:175-178 — person found but has zero messages
// (the "No messages present" branch, distinct from the no-match branch above).
async function testSequential_messagesPersonWithoutRecords() {
  const suffix = uid();
  const phone = `+1801${Date.now().toString().slice(-7)}`;
  const person = await createPerson(ctx.accessToken1!, {
    first_name: 'NoMsgs',
    last_name: `Person${suffix}`,
    phoneNumber: phone,
  });

  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ phone }),
  });
  assertStatus(res.status, 200, res.data);
  const data = res.data as {
    person: { id: string } | null;
    messages: unknown[];
    message?: string;
  };
  assert(data.person !== null, 'Expected person to be returned');
  assert(data.person!.id === person.id, 'Person ID mismatch');
  assert(data.messages.length === 0, 'Expected 0 messages');
  assert(
    typeof data.message === 'string' && data.message.includes('No messages present'),
    `Expected "No messages present" branch, got "${data.message}"`
  );
}

// Covers service.messages.ts:201-208 — recent messages with actual rows
// (formats them, returns count + days, exercises formatMessages from this entry too).
async function testSequential_recentMessagesReturnsRecords() {
  const suffix = uid();
  const phone = `+1802${Date.now().toString().slice(-7)}`;
  const person = await createPerson(ctx.accessToken1!, {
    first_name: 'RecentMsgs',
    last_name: `Person${suffix}`,
    phoneNumber: phone,
  });
  await seedMessage(person.id, {
    from: phone,
    to: '+15555550101',
    timestamp: new Date(),
    message: 'Recent test message body',
  });

  const res = await request(`${BASE_URL}/api/people/messages/recent?days=7`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'recent w/ records');
  assert(parsed.count >= 1, `Expected at least 1 recent message, got ${parsed.count}`);
  assert(parsed.days === 7, `Expected days=7, got ${parsed.days}`);
  const found = parsed.messages.some((m) => m.message === 'Recent test message body');
  assert(found, 'Expected to find seeded recent message');
}

// Covers service.messages.ts:198-200 — old timestamp is filtered out by the
// days cutoff.
async function testSequential_recentMessagesRespectsCutoff() {
  const suffix = uid();
  const phone = `+1803${Date.now().toString().slice(-7)}`;
  const person = await createPerson(ctx.accessToken1!, {
    first_name: 'OldMsgs',
    last_name: `Person${suffix}`,
    phoneNumber: phone,
  });
  // 100 days old — far outside the 1-day default cutoff.
  await seedMessage(person.id, {
    from: phone,
    to: '+15555550101',
    timestamp: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    message: `Stale message ${suffix}`,
  });

  const res = await request(`${BASE_URL}/api/people/messages/recent?days=1`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'recent cutoff');
  const found = parsed.messages.some((m) => m.message === `Stale message ${suffix}`);
  assert(!found, 'Old message should be excluded by cutoff');
}

// Covers routes.ts NaN-limit branches (search ?limit=abc, list ?limit=abc,
// recent ?limit=abc & ?days=abc) — the parseInt → NaN → undefined fallback.
async function testRoute_searchNaNLimit() {
  const res = await request(`${BASE_URL}/api/people/search?limit=abc`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ first_name: 'BBTest' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SearchPeopleResponse, res.data, 'search NaN limit');
}

async function testRoute_listNaNLimitAndPage() {
  const res = await request(`${BASE_URL}/api/people?limit=abc&page=xyz`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'list NaN limit/page');
  // Defaults applied: page=1, limit=DEFAULT_PEOPLE_LIMIT (2000).
  assert(parsed.pagination.page === 1, `Expected page=1, got ${parsed.pagination.page}`);
  assert(parsed.pagination.limit === 2000, `Expected limit=2000, got ${parsed.pagination.limit}`);
}

async function testRoute_recentNaNParams() {
  const res = await request(`${BASE_URL}/api/people/messages/recent?limit=abc&days=xyz`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(RecentMessagesResponse, res.data, 'recent NaN params');
  // days NaN → undefined → DEFAULT_RECENT_DAYS=1
  assert(parsed.days === 1, `Expected days=1 default, got ${parsed.days}`);
}

// Covers routes.ts internal POST /messages — internal caller (API key) without
// a user_id in body should hit the auth-resolver fall-through and 401.
async function testRoute_messagesInternalMissingUserId() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ firstName: 'Whoever' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /messages internal-no-user 401');
}

// Covers routes.ts internal POST /messages — empty-string user_id from internal
// caller is rejected as unauthorized (resolveUserId trims to '').
async function testRoute_messagesInternalEmptyUserId() {
  const res = await request(`${BASE_URL}/api/people/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ user_id: '   ', firstName: 'Whoever' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /messages internal-empty-user 401');
}

// Covers GET /api/people search-clause path with the "(firstName ' ' lastName)
// ILIKE" combined-name search clause via a multi-word search term.
async function testRoute_listSearchByFullName() {
  const suffix = uid();
  await createPerson(ctx.accessToken1!, {
    first_name: `Combined${suffix}`,
    last_name: `Search${suffix}`,
  });
  const res = await request(
    `${BASE_URL}/api/people?search=${encodeURIComponent(`Combined${suffix} Search`)}`,
    { headers: authHeaders(ctx.accessToken1!) }
  );
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'list full-name search');
  assert(
    parsed.pagination.total >= 1,
    `Expected at least one match for full name, got ${parsed.pagination.total}`
  );
}

// Covers list sort=communicationFrequency CASE branch with actual rows that
// exercise the daily/weekly/monthly ordering.
async function testRoute_listSortCommFreqOrder() {
  const suffix = uid();
  await createPerson(ctx.accessToken1!, {
    first_name: `Daily${suffix}`,
    last_name: 'Freq',
    communication_frequency: 'daily',
  });
  await createPerson(ctx.accessToken1!, {
    first_name: `Yearly${suffix}`,
    last_name: 'Freq',
    communication_frequency: 'yearly',
  });
  const res = await request(
    `${BASE_URL}/api/people?sort=communicationFrequency&sortDirection=asc&search=Freq&limit=50`,
    { headers: authHeaders(ctx.accessToken1!) }
  );
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'list comm-freq sort');
  // Daily (rank 0) should come before yearly (rank 3) when ASC.
  const daily = parsed.people.findIndex((p) => p.firstName === `Daily${suffix}`);
  const yearly = parsed.people.findIndex((p) => p.firstName === `Yearly${suffix}`);
  assert(daily >= 0 && yearly >= 0, 'Both seeded people should appear in list');
  assert(daily < yearly, `Expected daily before yearly, got daily=${daily}, yearly=${yearly}`);
}

// Covers list sort=communicationFrequency DESC direction (rank order reversed).
async function testRoute_listSortCommFreqDesc() {
  const suffix = uid();
  await createPerson(ctx.accessToken1!, {
    first_name: `DescDaily${suffix}`,
    last_name: 'FreqDesc',
    communication_frequency: 'daily',
  });
  await createPerson(ctx.accessToken1!, {
    first_name: `DescYearly${suffix}`,
    last_name: 'FreqDesc',
    communication_frequency: 'yearly',
  });
  const res = await request(
    `${BASE_URL}/api/people?sort=communicationFrequency&sortDirection=desc&search=FreqDesc&limit=50`,
    { headers: authHeaders(ctx.accessToken1!) }
  );
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListPeopleResponse, res.data, 'list comm-freq sort desc');
  const daily = parsed.people.findIndex((p) => p.firstName === `DescDaily${suffix}`);
  const yearly = parsed.people.findIndex((p) => p.firstName === `DescYearly${suffix}`);
  assert(daily >= 0 && yearly >= 0, 'Both seeded people should appear');
  // DESC: yearly (rank 3) should come before daily (rank 0).
  assert(
    yearly < daily,
    `Expected yearly before daily on DESC, got daily=${daily}, yearly=${yearly}`
  );
}

// ==================== EMBEDDINGS / COLLISION COVERAGE TESTS ====================
// These tests pre-seed the OpenAI embedding cache with deterministic responses
// so we exercise providers/embeddings.ts and providers/personCollision.ts paths
// without depending on a live OpenAI quota.

/**
 * Create a person via POST /api/people, pre-seeding the OpenAI embedding for
 * the exact signal text the SDK will request. Uses unique names per call so
 * the input text (and thus cache key) is unique and tests don't collide.
 */
async function createPersonWithSeededEmbedding(
  token: string,
  signals: Record<string, unknown>,
  embedding: number[]
): Promise<{ id: string; embedding: unknown }> {
  seedEmbeddingForSignals(signals, embedding);
  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(signals),
  });
  if (res.status !== 201) {
    throw new Error(
      `Seeded create failed (status ${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`
    );
  }
  const parsed = assertSchema(CreatePersonResponse, res.data, 'seeded create');
  return { id: parsed.person.id, embedding: parsed.person.embedding };
}

// Covers providers/embeddings.ts:buildPersonEmbeddingText all-fields branch
// (lines for age, location, profession, company, title, industry, relation,
// communication_frequency, relationship_quality, skills, interests, reach,
// net_worth, power_ranking, bandwidth, contact_status, network_orientation,
// notes) AND providers/embeddings.ts:getEmbedding userId-tracking branch
// (the toolUsage.create call, lines 179-194). Without seeding the OpenAI
// quota errors with 429 and the toolUsage path never executes.
async function testCoverage_createWithAllSignalsExercisesBuildText() {
  const suffix = uid();
  const signals: Record<string, unknown> = {
    first_name: `CovAll${suffix}`,
    last_name: 'Tester',
    age: 42,
    location: 'San Francisco, CA',
    profession: 'CEO',
    company: 'CovCo',
    title: 'Chief Coverage Officer',
    industry: 'Software',
    relation: 'colleague',
    communication_frequency: 'daily',
    relationship_quality: 'strong',
    skills: ['typescript', 'testing'],
    interests: ['coverage', 'quality'],
    total_online_reach: 250000,
    estimated_net_worth_usd: 12_500_000,
    estimated_world_power_ranking: 6,
    current_bandwidth: 'available',
    contact_status: 'active',
    network_orientation: 'connector',
    notes: 'Synthetic person for coverage testing',
  };
  const embedding = Array.from({ length: 1536 }, (_, i) => Math.sin(i / 100));
  const created = await createPersonWithSeededEmbedding(ctx.accessToken1!, signals, embedding);
  assert(created.embedding !== null, 'Expected embedding stored on created person');
  assert(Array.isArray(created.embedding), 'Expected embedding to be an array');
  assert(
    (created.embedding as unknown[]).length === 1536,
    `Expected 1536-dim embedding, got ${(created.embedding as unknown[]).length}`
  );

  // Verify a toolUsage row was tracked (covers getEmbedding lines 179-194).
  const usage = await prisma.toolUsage.findFirst({
    where: { userId: ctx.userId1!, toolName: 'generate_person_embedding' },
    orderBy: { createdAt: 'desc' },
  });
  assert(
    usage !== null,
    'Expected a toolUsage row tracking the embedding cost (getEmbedding tracking branch)'
  );
}

// Covers providers/embeddings.ts:searchPeopleBySignals (211-248) AND
// providers/embeddings.ts:cosineSimilarity (178-201). Pre-seeds the query
// embedding so the search path runs end-to-end on a fresh user with two
// directly-inserted people that have known embeddings.
async function testCoverage_searchExercisesCosineSimilarityAndScan() {
  // Use a fresh user so we own the entire person set deterministically.
  const session = await createAnonSession();

  // Two people with known embeddings, inserted directly via Prisma so we don't
  // depend on the create path's getEmbedding seeding.
  const closeVec = Array.from({ length: 1536 }, () => 0.5);
  const farVec = Array.from({ length: 1536 }, (_, i) => (i % 2 === 0 ? -0.5 : 0.5));
  const closePerson = await prisma.person.create({
    data: {
      userId: session.userId,
      firstName: `SearchClose${uid()}`,
      lastName: 'Tester',
      profession: 'Engineer',
      embedding: closeVec,
      skills: [],
      interests: [],
      emailAddresses: [],
    },
  });
  await prisma.person.create({
    data: {
      userId: session.userId,
      firstName: `SearchFar${uid()}`,
      lastName: 'Tester',
      profession: 'Engineer',
      embedding: farVec,
      skills: [],
      interests: [],
      emailAddresses: [],
    },
  });

  // Seed the search query's embedding so getEmbedding inside
  // searchPeopleBySignals returns a deterministic vector close to closeVec.
  const querySignals = { profession: `CovSearchTarget${uid()}` };
  seedEmbeddingForSignals(querySignals, closeVec);

  const res = await request(`${BASE_URL}/api/people/search?limit=5`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify(querySignals),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(SearchPeopleResponse, res.data, 'cov search');
  assert(parsed.results.length >= 2, `Expected at least 2 results, got ${parsed.results.length}`);
  // Because we generated the query vector identical to closeVec, that person's
  // similarity should be 1.0 and the highest among results — proves
  // cosineSimilarity actually ran and ranked correctly.
  assert(parsed.results[0].id === closePerson.id, 'Expected close-vec person as top match');
  assert(
    Math.abs(parsed.results[0].similarity - 1) < 1e-3,
    `Expected closeVec similarity ~= 1, got ${parsed.results[0].similarity}`
  );
  for (const r of parsed.results) {
    assert(typeof r.similarity === 'number', 'Expected numeric similarity');
    // Allow tiny floating-point overshoot beyond ±1 (identical vectors yield
    // a cosine of ~1.0000000000000002 due to fp64 sum-of-squares rounding).
    assert(
      r.similarity >= -1 - 1e-9 && r.similarity <= 1 + 1e-9,
      `Similarity out of range: ${r.similarity}`
    );
  }
}

// Covers providers/embeddings.ts:cosineSimilarity zero-magnitude branch
// (lines 196-198 — when one of the vectors has magnitude 0, return 0).
async function testCoverage_searchHandlesZeroMagnitudeEmbedding() {
  const session = await createAnonSession();

  // Person with all-zeros embedding triggers the magnitudeA===0 branch.
  await prisma.person.create({
    data: {
      userId: session.userId,
      firstName: `Zero${uid()}`,
      lastName: 'Vec',
      embedding: Array.from({ length: 1536 }, () => 0),
      skills: [],
      interests: [],
      emailAddresses: [],
    },
  });

  const querySignals = { profession: `ZeroQuery${uid()}` };
  // Non-zero query vector
  seedEmbeddingForSignals(
    querySignals,
    Array.from({ length: 1536 }, (_, i) => Math.cos(i / 50))
  );

  const res = await request(`${BASE_URL}/api/people/search`, {
    method: 'POST',
    headers: authHeaders(session.accessToken),
    body: JSON.stringify(querySignals),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(SearchPeopleResponse, res.data, 'cov zero-mag');
  assert(parsed.results.length === 1, `Expected 1 result, got ${parsed.results.length}`);
  // Zero-magnitude vector → cosineSimilarity returns 0 (early-out branch).
  assert(
    parsed.results[0].similarity === 0,
    `Expected similarity=0 for zero-vec person, got ${parsed.results[0].similarity}`
  );
}

// Covers providers/personCollision.ts:findCollision email-matching branch
// (lines 60-90 — primary email lookup) AND mergePersonRecords' field-merging
// logic for non-overlapping fields (lines 138-218). Two creates with the
// same email merge into one.
async function testCoverage_collisionByPrimaryEmailMerges() {
  const suffix = uid();
  const sharedEmail = `cov-collide-${suffix}@bbtest.example`;

  // Seed embeddings for both creates.
  const v1 = Array.from({ length: 1536 }, (_, i) => i / 1536);
  const v2 = Array.from({ length: 1536 }, (_, i) => 1 - i / 1536);
  const signals1 = {
    first_name: `EmailCollideA${suffix}`,
    last_name: 'First',
    email: sharedEmail,
    profession: 'Initial',
  };
  const signals2 = {
    first_name: `EmailCollideA${suffix}`,
    last_name: 'First',
    email: sharedEmail,
    profession: 'Updated',
    company: 'New Company',
    skills: ['merged-skill'],
  };
  seedEmbeddingForSignals(signals1, v1);

  // First create
  const r1 = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(signals1),
  });
  assertStatus(r1.status, 201, r1.data);
  const first = assertSchema(CreatePersonResponse, r1.data, 'collision-email first');
  assert(first.merged === false, 'First create should not be a merge');

  // Now seed the merge-time embedding (uses post-merge fields, so we must
  // compute that text). The merged signal set is the union: prefer new
  // values when present; existing values otherwise.
  const mergedSignalsForEmbedding = {
    first_name: signals2.first_name,
    last_name: signals2.last_name,
    profession: signals2.profession,
    company: signals2.company,
    skills: signals2.skills,
  };
  seedEmbeddingForSignals(mergedSignalsForEmbedding, v2);
  // Also seed for raw signals2 (pre-merge), just in case the create path
  // computes the embedding from the new data alone (it doesn't, but safe).
  seedEmbeddingForSignals(signals2, v2);

  const r2 = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(signals2),
  });
  assertStatus(r2.status, 200, r2.data);
  const second = assertSchema(CreatePersonResponse, r2.data, 'collision-email merge');
  assert(second.merged === true, 'Second create should merge on shared email');
  assert(second.person.id === first.person.id, 'Merged person should retain ID');
  assert(
    second.reason !== undefined && /email/i.test(second.reason),
    `Expected reason mentioning email, got: ${second.reason}`
  );
  assert(
    second.person.profession === 'Updated',
    `Expected merged profession=Updated, got ${second.person.profession}`
  );
  assert(
    second.person.company === 'New Company',
    `Expected merged company=New Company, got ${second.person.company}`
  );
}

// Covers providers/personCollision.ts:findCollision emailAddresses-array
// branch (lines 73-78 — looking up by additional emails on the array
// field). Inserts a person with email in emailAddresses[], then creates a
// new person whose primary email matches one of those.
async function testCoverage_collisionByEmailAddressesArrayMerges() {
  const suffix = uid();
  const altEmail = `cov-alt-${suffix}@bbtest.example`;

  // Person with altEmail only in emailAddresses[] (not in primary email field).
  // Insert directly via Prisma to bypass the upsert's primary-email assignment.
  const existing = await prisma.person.create({
    data: {
      userId: ctx.userId1!,
      firstName: `AltEmailA${suffix}`,
      lastName: 'First',
      email: `cov-primary-${suffix}@bbtest.example`,
      emailAddresses: [altEmail],
      skills: [],
      interests: [],
    },
  });

  // New create with altEmail as primary should collide via emailAddresses array.
  const v = Array.from({ length: 1536 }, (_, i) => 0.1 * i);
  const signals = {
    first_name: `AltEmailB${suffix}`,
    last_name: 'Second',
    email: altEmail,
    profession: 'Resolved',
  };
  seedEmbeddingForSignals(signals, v);
  // Also seed merge-time embedding (post-merge will include first_name/last_name
  // from existing because we provided new ones — actually new override existing).
  seedEmbeddingForSignals(
    {
      first_name: signals.first_name,
      last_name: signals.last_name,
      profession: signals.profession,
    },
    v
  );

  const res = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(signals),
  });
  assertStatus(res.status, 200, res.data);
  const merged = assertSchema(CreatePersonResponse, res.data, 'cov alt-email merge');
  assert(merged.merged === true, 'Expected merge via emailAddresses array');
  assert(merged.person.id === existing.id, 'Merged person should retain existing ID');
}

// Covers providers/personCollision.ts:mergePersonRecords array-dedupe branch
// (lines 154-166 — mergeArrays helper combines + dedupes existing and new).
// Two creates with overlapping skills/interests should produce a deduped union.
async function testCoverage_collisionMergesSkillsAndInterestsDedup() {
  const suffix = uid();
  const phone = `+1985${Date.now().toString().slice(-7)}`;

  const v = Array.from({ length: 1536 }, (_, i) => Math.tan(i / 200));
  const signals1 = {
    first_name: `MergeArr${suffix}`,
    last_name: 'First',
    phoneNumber: phone,
    skills: ['typescript', 'react'],
    interests: ['music', 'art'],
  };
  seedEmbeddingForSignals(signals1, v);
  const r1 = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(signals1),
  });
  assertStatus(r1.status, 201, r1.data);
  const first = assertSchema(CreatePersonResponse, r1.data, 'merge-arr first');

  const signals2 = {
    first_name: `MergeArr${suffix}`,
    last_name: 'Second',
    phoneNumber: phone,
    skills: ['typescript', 'go'], // typescript overlaps; go is new
    interests: ['art', 'travel'], // art overlaps; travel is new
  };
  // The merge embedding text is computed from the merged signals (union).
  // Seed both possible inputs so we cover whichever path runs.
  seedEmbeddingForSignals(signals2, v);
  seedEmbeddingForSignals(
    {
      first_name: signals2.first_name,
      last_name: signals2.last_name,
      skills: ['typescript', 'react', 'go'],
      interests: ['music', 'art', 'travel'],
    },
    v
  );

  const r2 = await request(`${BASE_URL}/api/people`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify(signals2),
  });
  assertStatus(r2.status, 200, r2.data);
  const second = assertSchema(CreatePersonResponse, r2.data, 'merge-arr merge');
  assert(second.merged === true, 'Expected phone-based merge');
  assert(second.person.id === first.person.id, 'Same ID after merge');

  const skills = (second.person.skills as string[]) ?? [];
  const interests = (second.person.interests as string[]) ?? [];
  assert(skills.includes('typescript'), 'Expected typescript in merged skills');
  assert(skills.includes('react'), 'Expected react in merged skills');
  assert(skills.includes('go'), 'Expected go in merged skills');
  assert(skills.filter((s) => s === 'typescript').length === 1, 'Expected dedup of typescript');
  assert(interests.includes('music'), 'Expected music in merged interests');
  assert(interests.includes('art'), 'Expected art in merged interests');
  assert(interests.includes('travel'), 'Expected travel in merged interests');
  assert(interests.filter((i) => i === 'art').length === 1, 'Expected dedup of art');
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
      result.similarity >= -1 - 1e-9 && result.similarity <= 1 + 1e-9,
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
    { name: 'POST /search -- NaN limit param', fn: testRoute_searchNaNLimit },
    { name: 'GET / -- NaN limit/page params', fn: testRoute_listNaNLimitAndPage },
    { name: 'GET /messages/recent -- NaN params', fn: testRoute_recentNaNParams },
    {
      name: 'POST /messages -- internal missing user_id -> 401',
      fn: testRoute_messagesInternalMissingUserId,
    },
    {
      name: 'POST /messages -- internal empty user_id -> 401',
      fn: testRoute_messagesInternalEmptyUserId,
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

  // Phase 3: Sequential state-dependent + boundary tests
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'sequential -- delete and verify 404', fn: testSequential_deleteAndVerify },
    {
      name: 'sequential -- messages for created person',
      fn: testSequential_messagesForCreatedPerson,
    },
    { name: 'sequential -- collision merge', fn: testSequential_collisionMerge },
    {
      name: 'sequential -- messages return seeded records',
      fn: testSequential_messagesReturnRecords,
    },
    {
      name: 'sequential -- messages respects message_limit',
      fn: testSequential_messagesRespectsLimit,
    },
    {
      name: 'sequential -- messages multiple matches by name',
      fn: testSequential_messagesMultipleMatches,
    },
    {
      name: 'sequential -- messages multiple matches by email',
      fn: testSequential_messagesMultipleMatchesByEmail,
    },
    {
      name: 'sequential -- person found but no messages',
      fn: testSequential_messagesPersonWithoutRecords,
    },
    {
      name: 'sequential -- recent messages returns seeded records',
      fn: testSequential_recentMessagesReturnsRecords,
    },
    {
      name: 'sequential -- recent messages respects days cutoff',
      fn: testSequential_recentMessagesRespectsCutoff,
    },
    {
      name: 'sequential -- list search by full name (combined ILIKE)',
      fn: testRoute_listSearchByFullName,
    },
    {
      name: 'sequential -- list sort communicationFrequency ASC ordering',
      fn: testRoute_listSortCommFreqOrder,
    },
    {
      name: 'sequential -- list sort communicationFrequency DESC ordering',
      fn: testRoute_listSortCommFreqDesc,
    },
    {
      name: 'boundary -- create generates embedding',
      fn: testBoundary_createEmbeddingGenerated,
    },
    {
      name: 'boundary -- search uses embeddings',
      fn: testBoundary_searchEmbeddingUsed,
    },
    // ---- embeddings.ts + personCollision.ts coverage ----
    {
      name: 'coverage -- create with all signals exercises buildPersonEmbeddingText',
      fn: testCoverage_createWithAllSignalsExercisesBuildText,
    },
    {
      name: 'coverage -- search exercises cosineSimilarity + searchPeopleBySignals',
      fn: testCoverage_searchExercisesCosineSimilarityAndScan,
    },
    {
      name: 'coverage -- search handles zero-magnitude embedding (cosineSimilarity early-out)',
      fn: testCoverage_searchHandlesZeroMagnitudeEmbedding,
    },
    {
      name: 'coverage -- collision by primary email merges (findCollision email branch)',
      fn: testCoverage_collisionByPrimaryEmailMerges,
    },
    {
      name: 'coverage -- collision by emailAddresses array merges',
      fn: testCoverage_collisionByEmailAddressesArrayMerges,
    },
    {
      name: 'coverage -- collision merges skills/interests with dedup',
      fn: testCoverage_collisionMergesSkillsAndInterestsDedup,
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

  // Disconnect Prisma so the test process exits cleanly.
  await prisma.$disconnect();

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
