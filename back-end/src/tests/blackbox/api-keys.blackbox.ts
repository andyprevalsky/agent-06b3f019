#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for /api/api-keys
 *
 * Covers:
 *   GET  /api/api-keys       — list all API keys (masked) for the authenticated user
 *   POST /api/api-keys       — generate a new API key (requires subscription)
 *   DELETE /api/api-keys/:id  — delete an API key
 *
 * Each test case owns its own users, subscription fixtures, and API key state
 * so the full suite can run in parallel at CASE_CONCURRENCY=30.
 *
 * Boundary capture tests:
 *   N/A — this domain has zero third-party HTTP calls. All operations are
 *   Prisma → Postgres. No outbound fetch calls to capture or assert on.
 *
 * Invariants covered:
 *   - auth boundary: all endpoints reject unauthenticated and API-key-only requests
 *   - error-surface: all error responses include { error: string } with consistent shape
 *   - idempotency: double-delete returns 404 on second attempt
 *   - read-after-write: create → list shows key; delete → list omits key
 *   - permission/tenant isolation: users see and delete only their own keys
 *   - duplication prevention: each generated key has a unique id and apiKey value
 *   - masking: listed keys always show "..." + last 4 chars, never full key
 *   - same-input reproducibility: identical create requests produce same-shaped responses
 *   - cleanup: all seeded data (users, subscriptions, keys) cleaned up after run
 *
 * Invariants not applicable:
 *   - boundary param: no third-party HTTP calls in this domain
 *   - call ordering: no third-party HTTP calls in this domain
 *   - concurrency: no concurrent mutation semantics (each key is independent)
 *   - state transition: no state machine (keys are created or deleted, no transitions)
 *   - ordering/pagination: no pagination; simple desc order tested
 *   - atomicity: single DB operations per request
 *   - referential integrity: cascade delete enforced by Prisma schema, not route logic
 *   - event/job cardinality: no async events emitted
 *   - time/clock: only createdAt, no time-based business logic
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Usage:
 *   npx tsx src/tests/blackbox/api-keys.blackbox.ts
 */

import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../providers/database';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const FAKE_UUID = '00000000-0000-0000-0000-000000000000';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;
const rawCaseConcurrency =
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY || process.env.CONTRACT_TEST_CASE_CONCURRENCY;
const CASE_CONCURRENCY = rawCaseConcurrency ? Number(rawCaseConcurrency) : 30;

if (!Number.isInteger(CASE_CONCURRENCY) || CASE_CONCURRENCY <= 0) {
  throw new Error(
    `Invalid BLACKBOX_TEST_CASE_CONCURRENCY/CONTRACT_TEST_CASE_CONCURRENCY: ${rawCaseConcurrency}`
  );
}

// ==================== Tracking for cleanup ====================

const trackedUserIds = new Set<string>();
const trackedSubscriptionUserIds = new Set<string>();
const trackedApiKeyIds = new Set<string>();
const trackedDirectSeededUserIds = new Set<string>();

// ==================== Response schemas ====================

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

// ==================== Test infrastructure ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface AnonymousSessionData {
  session: { access_token: string };
  user: { id: string };
}

interface Fixture {
  label: string;
  token: string;
  userId: string;
  hasSubscription: boolean;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Can't reach database server") ||
    message.includes('Server has closed the connection') ||
    message.includes('Timed out fetching a new connection') ||
    message.includes('P1001') ||
    message.includes('P1017') ||
    message.includes('P2024')
  );
}

async function withTransientDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 6
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === attempts) {
        throw error;
      }
      console.warn(
        `[retry] ${label} failed on attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

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

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, workerIndex: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(workerIndex: number): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], workerIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => runWorker(i)));
  return results;
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

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// ==================== Fixture helpers ====================

async function createAnonymousSession(label: string): Promise<AnonymousSessionData> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
    if (res.status === 200) {
      const data = res.data as AnonymousSessionData;
      trackedUserIds.add(data.user.id);
      return data;
    }

    const transientFailure =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data &&
      (res.data as { error?: string }).error === 'Failed to create anonymous session';

    if (!transientFailure || attempt === 6) {
      assertStatus(res.status, 200, res.data);
    }

    console.warn(
      `[retry] auth anonymous for ${label} failed on attempt ${attempt}/6: ${JSON.stringify(res.data)}`
    );
    await sleep(250 * attempt);
  }

  throw new Error(`Anonymous session setup exhausted retries for ${label}`);
}

async function seedUser(userId: string): Promise<void> {
  trackedDirectSeededUserIds.add(userId);
  await withTransientDbRetry(`seedUser:${userId}`, async () => {
    await prisma.user.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        isAnonymous: true,
      },
    });
  });
}

async function seedSubscription(userId: string): Promise<void> {
  trackedSubscriptionUserIds.add(userId);
  await seedUser(userId);
  await withTransientDbRetry(`seedSubscription:${userId}`, async () => {
    await prisma.subscription.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        subscriptionTier: 1,
        stripeSubscriptionId: `test_sub_${RUN_ID}_${randomUUID().slice(0, 8)}`,
        stripeCustomerId: `test_cus_${RUN_ID}_${randomUUID().slice(0, 8)}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  });
}

async function createFixture(label: string, withSubscription: boolean): Promise<Fixture> {
  const session = await createAnonymousSession(label);
  if (withSubscription) {
    await seedSubscription(session.user.id);
  }
  return {
    label,
    token: session.session.access_token,
    userId: session.user.id,
    hasSubscription: withSubscription,
  };
}

function trackApiKeyId(id: string): void {
  trackedApiKeyIds.add(id);
}

// ==================== Cleanup ====================

async function cleanupFixtures(): Promise<void> {
  const userIds = Array.from(trackedUserIds);
  const subUserIds = Array.from(trackedSubscriptionUserIds);
  const keyIds = Array.from(trackedApiKeyIds);
  const directSeededUserIds = Array.from(trackedDirectSeededUserIds);

  if (
    userIds.length === 0 &&
    subUserIds.length === 0 &&
    keyIds.length === 0 &&
    directSeededUserIds.length === 0
  ) {
    return;
  }

  await withTransientDbRetry('cleanupFixtures', async () => {
    if (userIds.length > 0) {
      await prisma.roseApiKey.deleteMany({
        where: { userId: { in: userIds } },
      });
    }

    if (keyIds.length > 0) {
      await prisma.roseApiKey.deleteMany({
        where: { id: { in: keyIds } },
      });
    }

    if (subUserIds.length > 0) {
      await prisma.subscription.deleteMany({
        where: { userId: { in: subUserIds } },
      });
    }

    if (directSeededUserIds.length > 0) {
      // Delete credits first (FK child of User) before removing User records
      await prisma.credit.deleteMany({
        where: { userId: { in: directSeededUserIds } },
      });
      await prisma.user.deleteMany({
        where: { userId: { in: directSeededUserIds } },
      });
    }
  });
}

// ==================== GET / (list) — contract tests ====================

async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/api-keys`);
  assertStatus(res.status, 401, res.data);
}

async function testList_apiKeyAuth() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 401, res.data);
}

async function testList_emptyForNewUser() {
  const fixture = await createFixture('list-empty', false);
  const res = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(fixture.token),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(ListApiKeysResponse, res.data, 'GET /');
  assert(parsed.keys.length === 0, `Expected 0 keys for new user, got ${parsed.keys.length}`);
}

async function testList_returnsMaskedKeysAfterCreation() {
  const fixture = await createFixture('list-masked', true);
  // Create a key
  const createRes = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'masked-test-key' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateApiKeyResponse, createRes.data, 'POST / (create for list)');
  trackApiKeyId(created.id);

  // List and verify masking
  const listRes = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(fixture.token),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const parsed = assertSchema(ListApiKeysResponse, listRes.data, 'GET / (after create)');
  assert(parsed.keys.length >= 1, `Expected at least 1 key, got ${parsed.keys.length}`);

  const found = parsed.keys.find((k) => k.id === created.id);
  assert(found, `Created key ${created.id} not found in list`);
  assert(
    found!.name === 'masked-test-key',
    `Expected name 'masked-test-key', got '${found!.name}'`
  );

  // Verify masking: should be "...XXXX" where XXXX is last 4 chars of the full key
  const expectedMasked = `...${created.apiKey.slice(-4)}`;
  assert(
    found!.maskedApiKey === expectedMasked,
    `Expected maskedApiKey '${expectedMasked}', got '${found!.maskedApiKey}'`
  );

  // Full key must NOT appear in the list response
  assert(
    !JSON.stringify(parsed).includes(created.apiKey),
    'Full API key must not appear in list response'
  );
}

async function testList_orderedByCreatedAtDesc() {
  const fixture = await createFixture('list-order', true);

  // Create two keys with a small gap
  const res1 = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'first-key' }),
  });
  assertStatus(res1.status, 200, res1.data);
  const key1 = assertSchema(CreateApiKeyResponse, res1.data, 'POST / key1');
  trackApiKeyId(key1.id);

  const res2 = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'second-key' }),
  });
  assertStatus(res2.status, 200, res2.data);
  const key2 = assertSchema(CreateApiKeyResponse, res2.data, 'POST / key2');
  trackApiKeyId(key2.id);

  const listRes = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(fixture.token),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const parsed = assertSchema(ListApiKeysResponse, listRes.data, 'GET / (ordered)');

  const ids = parsed.keys.map((k) => k.id);
  const idx1 = ids.indexOf(key1.id);
  const idx2 = ids.indexOf(key2.id);
  assert(idx1 !== -1 && idx2 !== -1, 'Both keys should appear in list');
  assert(idx2 < idx1, `Second key (newer) should appear before first key (older) in desc order`);
}

// ==================== POST / (create) — contract tests ====================

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Key' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCreate_apiKeyAuth() {
  const res = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ name: 'Test Key' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCreate_noSubscription() {
  const fixture = await createFixture('create-no-sub', false);
  const res = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'Test Key' }),
  });
  assertStatus(res.status, 403, res.data);
  const parsed = assertSchema(ErrorResponse, res.data, 'POST / (403 no subscription)');
  assert(
    parsed.error.toLowerCase().includes('subscription'),
    `Expected subscription-related error, got: ${parsed.error}`
  );
}

async function testCreate_happyWithName() {
  const fixture = await createFixture('create-happy-name', true);
  const res = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'My Production Key' }),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(CreateApiKeyResponse, res.data, 'POST / (happy with name)');
  trackApiKeyId(parsed.id);

  assert(
    parsed.name === 'My Production Key',
    `Expected name 'My Production Key', got '${parsed.name}'`
  );
  assert(
    typeof parsed.apiKey === 'string' && parsed.apiKey.length === 32,
    `Expected 32-char API key, got '${parsed.apiKey}' (length ${parsed.apiKey?.length})`
  );
  assert(typeof parsed.id === 'string' && parsed.id.length > 0, 'Expected non-empty id');
  assert(parsed.createdAt !== undefined, 'Expected createdAt to be set');
}

async function testCreate_happyWithoutName() {
  const fixture = await createFixture('create-happy-no-name', true);
  const res = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 200, res.data);
  const parsed = assertSchema(CreateApiKeyResponse, res.data, 'POST / (happy no name)');
  trackApiKeyId(parsed.id);

  assert(parsed.name === null, `Expected null name, got '${parsed.name}'`);
  assert(
    parsed.apiKey.length === 32,
    `Expected 32-char API key, got length ${parsed.apiKey.length}`
  );
}

async function testCreate_keysAreUnique() {
  const fixture = await createFixture('create-unique', true);

  const res1 = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'key-1' }),
  });
  assertStatus(res1.status, 200, res1.data);
  const key1 = assertSchema(CreateApiKeyResponse, res1.data, 'POST / key1');
  trackApiKeyId(key1.id);

  const res2 = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'key-2' }),
  });
  assertStatus(res2.status, 200, res2.data);
  const key2 = assertSchema(CreateApiKeyResponse, res2.data, 'POST / key2');
  trackApiKeyId(key2.id);

  assert(key1.apiKey !== key2.apiKey, 'Two created keys must have different apiKey values');
  assert(key1.id !== key2.id, 'Two created keys must have different ids');
}

// ==================== DELETE /:id — contract tests ====================

async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/api-keys/${FAKE_UUID}`, {
    method: 'DELETE',
  });
  assertStatus(res.status, 401, res.data);
}

async function testDelete_apiKeyAuth() {
  const res = await request(`${BASE_URL}/api/api-keys/${FAKE_UUID}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 401, res.data);
}

async function testDelete_notFound() {
  const fixture = await createFixture('delete-not-found', false);
  const res = await request(`${BASE_URL}/api/api-keys/${FAKE_UUID}`, {
    method: 'DELETE',
    headers: authHeaders(fixture.token),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'DELETE /:id (404)');
}

async function testDelete_happy() {
  const fixture = await createFixture('delete-happy', true);

  // Create a key
  const createRes = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'to-delete' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateApiKeyResponse, createRes.data, 'POST / (for delete)');
  trackApiKeyId(created.id);

  // Delete it
  const deleteRes = await request(`${BASE_URL}/api/api-keys/${created.id}`, {
    method: 'DELETE',
    headers: authHeaders(fixture.token),
  });
  assertStatus(deleteRes.status, 200, deleteRes.data);
  assertSchema(DeleteApiKeyResponse, deleteRes.data, 'DELETE /:id (happy)');

  // Verify gone from list
  const listRes = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(fixture.token),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const parsed = assertSchema(ListApiKeysResponse, listRes.data, 'GET / (after delete)');
  const found = parsed.keys.find((k) => k.id === created.id);
  assert(!found, `Deleted key ${created.id} should not appear in list`);
}

async function testDelete_doubleDelete() {
  const fixture = await createFixture('delete-double', true);

  // Create a key
  const createRes = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'double-delete' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateApiKeyResponse, createRes.data, 'POST / (for double-delete)');
  trackApiKeyId(created.id);

  // First delete
  const del1 = await request(`${BASE_URL}/api/api-keys/${created.id}`, {
    method: 'DELETE',
    headers: authHeaders(fixture.token),
  });
  assertStatus(del1.status, 200, del1.data);

  // Second delete → 404
  const del2 = await request(`${BASE_URL}/api/api-keys/${created.id}`, {
    method: 'DELETE',
    headers: authHeaders(fixture.token),
  });
  assertStatus(del2.status, 404, del2.data);
}

async function testDelete_wrongUser() {
  const owner = await createFixture('delete-wrong-owner', true);
  const other = await createFixture('delete-wrong-other', false);

  // Owner creates a key
  const createRes = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(owner.token),
    body: JSON.stringify({ name: 'owner-key' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateApiKeyResponse, createRes.data, 'POST / (for wrong-user)');
  trackApiKeyId(created.id);

  // Other user tries to delete → 404 (not found because ownership check)
  const deleteRes = await request(`${BASE_URL}/api/api-keys/${created.id}`, {
    method: 'DELETE',
    headers: authHeaders(other.token),
  });
  assertStatus(deleteRes.status, 404, deleteRes.data);

  // Verify key still exists for owner
  const listRes = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(owner.token),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const parsed = assertSchema(ListApiKeysResponse, listRes.data, 'GET / (after wrong-user delete)');
  const found = parsed.keys.find((k) => k.id === created.id);
  assert(found, `Key should still exist for owner after failed delete by other user`);
}

// ==================== Characterization / invariant tests ====================

async function testTenantIsolation_listOnlyOwn() {
  const userA = await createFixture('iso-userA', true);
  const userB = await createFixture('iso-userB', true);

  // User A creates a key
  const resA = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(userA.token),
    body: JSON.stringify({ name: 'userA-key' }),
  });
  assertStatus(resA.status, 200, resA.data);
  const keyA = assertSchema(CreateApiKeyResponse, resA.data, 'POST / (userA)');
  trackApiKeyId(keyA.id);

  // User B creates a key
  const resB = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(userB.token),
    body: JSON.stringify({ name: 'userB-key' }),
  });
  assertStatus(resB.status, 200, resB.data);
  const keyB = assertSchema(CreateApiKeyResponse, resB.data, 'POST / (userB)');
  trackApiKeyId(keyB.id);

  // User A's list should contain only their key
  const listA = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(userA.token),
  });
  assertStatus(listA.status, 200, listA.data);
  const parsedA = assertSchema(ListApiKeysResponse, listA.data, 'GET / (userA list)');
  const aIds = parsedA.keys.map((k) => k.id);
  assert(aIds.includes(keyA.id), "User A's list must include their own key");
  assert(!aIds.includes(keyB.id), "User A's list must NOT include user B's key");

  // User B's list should contain only their key
  const listB = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(userB.token),
  });
  assertStatus(listB.status, 200, listB.data);
  const parsedB = assertSchema(ListApiKeysResponse, listB.data, 'GET / (userB list)');
  const bIds = parsedB.keys.map((k) => k.id);
  assert(bIds.includes(keyB.id), "User B's list must include their own key");
  assert(!bIds.includes(keyA.id), "User B's list must NOT include user A's key");
}

async function testReadAfterWrite_createThenList() {
  const fixture = await createFixture('raw-create-list', true);

  // Create
  const createRes = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'raw-check' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateApiKeyResponse, createRes.data, 'POST / (raw)');
  trackApiKeyId(created.id);

  // List immediately
  const listRes = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(fixture.token),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const parsed = assertSchema(ListApiKeysResponse, listRes.data, 'GET / (raw after create)');
  const found = parsed.keys.find((k) => k.id === created.id);
  assert(found, 'Newly created key must appear in list immediately');
}

async function testReadAfterWrite_deleteThenList() {
  const fixture = await createFixture('raw-delete-list', true);

  // Create
  const createRes = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'raw-delete-check' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateApiKeyResponse, createRes.data, 'POST / (for raw delete)');
  trackApiKeyId(created.id);

  // Delete
  const deleteRes = await request(`${BASE_URL}/api/api-keys/${created.id}`, {
    method: 'DELETE',
    headers: authHeaders(fixture.token),
  });
  assertStatus(deleteRes.status, 200, deleteRes.data);

  // List immediately
  const listRes = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(fixture.token),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const parsed = assertSchema(ListApiKeysResponse, listRes.data, 'GET / (raw after delete)');
  const found = parsed.keys.find((k) => k.id === created.id);
  assert(!found, 'Deleted key must not appear in list immediately after deletion');
}

async function testMaskingInvariant() {
  const fixture = await createFixture('mask-invariant', true);

  const createRes = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'mask-test' }),
  });
  assertStatus(createRes.status, 200, createRes.data);
  const created = assertSchema(CreateApiKeyResponse, createRes.data, 'POST / (mask)');
  trackApiKeyId(created.id);

  const listRes = await request(`${BASE_URL}/api/api-keys`, {
    headers: authHeaders(fixture.token),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const parsed = assertSchema(ListApiKeysResponse, listRes.data, 'GET / (mask check)');

  // Every key in the list must be masked
  for (const key of parsed.keys) {
    assert(
      key.maskedApiKey.startsWith('...'),
      `Masked key should start with '...', got '${key.maskedApiKey}'`
    );
    assert(
      key.maskedApiKey.length === 7,
      `Masked key should be 7 chars ('...' + 4), got ${key.maskedApiKey.length}`
    );
  }
}

async function testErrorSurfaceInvariant() {
  const fixture = await createFixture('error-surface', false);

  // All error responses should match ErrorResponse schema
  const endpoints: Array<{ method: string; url: string; body?: string }> = [
    { method: 'GET', url: `${BASE_URL}/api/api-keys` },
    { method: 'POST', url: `${BASE_URL}/api/api-keys`, body: JSON.stringify({ name: 'test' }) },
    { method: 'DELETE', url: `${BASE_URL}/api/api-keys/${FAKE_UUID}` },
  ];

  // Without auth, all should return 401
  for (const ep of endpoints) {
    const res = await request(ep.url, {
      method: ep.method,
      ...(ep.body ? { body: ep.body } : {}),
    });
    assertStatus(res.status, 401, res.data);
    // Verify error responses are valid JSON with error field
    assert(
      typeof res.data === 'object' && res.data !== null && 'error' in res.data,
      `Error response for ${ep.method} ${ep.url} should have 'error' field`
    );
  }

  // With auth but no subscription, POST should return 403 with ErrorResponse schema
  const postRes = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'test' }),
  });
  assertStatus(postRes.status, 403, postRes.data);
  assertSchema(ErrorResponse, postRes.data, 'POST / error surface (403)');
}

async function testSameInputReproducibility() {
  const fixture = await createFixture('repro', true);

  // Two create calls with same name produce same-shaped but different-valued responses
  const res1 = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'repro-key' }),
  });
  assertStatus(res1.status, 200, res1.data);
  const key1 = assertSchema(CreateApiKeyResponse, res1.data, 'POST / repro1');
  trackApiKeyId(key1.id);

  const res2 = await request(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: authHeaders(fixture.token),
    body: JSON.stringify({ name: 'repro-key' }),
  });
  assertStatus(res2.status, 200, res2.data);
  const key2 = assertSchema(CreateApiKeyResponse, res2.data, 'POST / repro2');
  trackApiKeyId(key2.id);

  // Same shape (both pass schema), different values
  assert(key1.id !== key2.id, 'Same-input creates must produce different ids');
  assert(key1.apiKey !== key2.apiKey, 'Same-input creates must produce different apiKeys');
  assert(key1.name === key2.name, 'Same-input creates must produce same name');
}

// ==================== Runner ====================

async function runAll() {
  console.log(`API Keys Black-box Tests (caseConcurrency=${CASE_CONCURRENCY}, runId=${RUN_ID})\n`);
  console.log(`Testing against: ${BASE_URL}\n`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'GET / (list)',
      tests: [
        { name: 'no auth -> 401', fn: testList_noAuth },
        { name: 'API key auth (no user) -> 401', fn: testList_apiKeyAuth },
        { name: 'empty list for new user', fn: testList_emptyForNewUser },
        { name: 'returns masked keys after creation', fn: testList_returnsMaskedKeysAfterCreation },
        { name: 'ordered by createdAt desc', fn: testList_orderedByCreatedAtDesc },
      ],
    },
    {
      name: 'POST / (create)',
      tests: [
        { name: 'no auth -> 401', fn: testCreate_noAuth },
        { name: 'API key auth (no user) -> 401', fn: testCreate_apiKeyAuth },
        { name: 'no subscription -> 403', fn: testCreate_noSubscription },
        { name: 'happy path with name', fn: testCreate_happyWithName },
        { name: 'happy path without name (null)', fn: testCreate_happyWithoutName },
        { name: 'generated keys are unique', fn: testCreate_keysAreUnique },
      ],
    },
    {
      name: 'DELETE /:id',
      tests: [
        { name: 'no auth -> 401', fn: testDelete_noAuth },
        { name: 'API key auth (no user) -> 401', fn: testDelete_apiKeyAuth },
        { name: 'not found -> 404', fn: testDelete_notFound },
        { name: 'happy path deletes and removes from list', fn: testDelete_happy },
        { name: 'double delete -> 404', fn: testDelete_doubleDelete },
        { name: 'wrong user -> 404 (ownership)', fn: testDelete_wrongUser },
      ],
    },
    {
      name: 'Invariants',
      tests: [
        { name: 'tenant isolation: users see only own keys', fn: testTenantIsolation_listOnlyOwn },
        { name: 'read-after-write: create then list', fn: testReadAfterWrite_createThenList },
        { name: 'read-after-write: delete then list', fn: testReadAfterWrite_deleteThenList },
        { name: 'masking invariant: all listed keys masked', fn: testMaskingInvariant },
        { name: 'error surface: consistent error shapes', fn: testErrorSurfaceInvariant },
        { name: 'same-input reproducibility', fn: testSameInputReproducibility },
      ],
    },
  ];

  const orderedTests = groups.flatMap((group) =>
    group.tests.map((test) => ({
      groupName: group.name,
      testName: test.name,
      fullName: `${group.name} - ${test.name}`,
      fn: test.fn,
    }))
  );

  const resultMap = new Map<string, TestResult>();

  try {
    const results = await runWithConcurrency(orderedTests, CASE_CONCURRENCY, async (test) => ({
      key: test.fullName,
      result: await runTest(test.fullName, test.fn),
    }));

    for (const item of results) {
      resultMap.set(item.key, item.result);
    }

    for (const group of groups) {
      console.log(`\n${group.name}`);
      for (const test of group.tests) {
        const key = `${group.name} - ${test.name}`;
        const result = resultMap.get(key)!;
        const prefix = result.passed ? '  PASS' : '  FAIL';
        console.log(
          `${prefix} ${test.name}${result.passed ? '' : ` - ${result.error}`} (${result.duration}ms)`
        );
      }
    }

    const allResults = Array.from(resultMap.values());
    const passed = allResults.filter((r) => r.passed).length;
    const failed = allResults.length - passed;

    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed, ${allResults.length} total`);

    if (failed > 0) {
      console.log('\nFailures:');
      for (const [key, result] of resultMap.entries()) {
        if (!result.passed) {
          console.log(`  - ${key}: ${result.error}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    console.log('\nAll api-keys black-box tests passed.');
    process.exitCode = 0;
  } finally {
    await cleanupFixtures();
  }
}

runAll().catch(async (error) => {
  console.error('\nAPI Keys black-box test suite crashed:', error);
  try {
    await cleanupFixtures();
  } catch (cleanupError) {
    console.error('Cleanup failed:', cleanupError);
  }
  process.exit(1);
});
