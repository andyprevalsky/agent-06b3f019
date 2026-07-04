#!/usr/bin/env tsx
/* eslint-disable max-lines */
/**
 * Black-box and characterization tests for /api/attention-requests.
 *
 * This suite is intentionally parallel within the domain: every test case owns
 * its own users, agent fixture, workflow IDs, and request state.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/attention-requests.blackbox.ts
 */

import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../providers/database';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const DATE_LIKE = z.union([z.string(), z.date()]);
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

const trackedRealAgentIds = new Set<string>();
const trackedRequestAgentIds = new Set<string>();
const trackedUserIds = new Set<string>();

const ErrorResponse = z.object({
  error: z.string(),
  details: z.array(z.any()).optional(),
});

const CreateAttentionRequestResponse = z.object({
  id: z.string(),
  created_at: DATE_LIKE,
  metadata: z.any(),
});

const AttentionRequestItem = z.object({
  id: z.string(),
  agent_id: z.string(),
  workflow_id: z.string(),
  question: z.string(),
  image_url: z.string().nullable(),
  metadata: z.any(),
  user_response: z.string().nullable(),
  created_at: DATE_LIKE,
  updated_at: DATE_LIKE,
  answered: z.boolean(),
});

const ListAttentionRequestsResponse = z.object({
  requests: z.array(AttentionRequestItem),
});

const CountResponse = z.object({
  count: z.number(),
});

const GetAttentionRequestResponse = z.object({
  id: z.string(),
  agentId: z.string(),
  workflowId: z.string(),
  question: z.string(),
  imageUrl: z.string().nullable(),
  metadata: z.any(),
  userResponse: z.string().nullable(),
  createdAt: DATE_LIKE,
  updatedAt: DATE_LIKE,
});

const ActionResponse = z.object({
  success: z.boolean(),
  request_id: z.string(),
});

type CreateAttentionRequestBody = z.infer<typeof CreateAttentionRequestResponse>;
type ListAttentionRequestsBody = z.infer<typeof ListAttentionRequestsResponse>;
type GetAttentionRequestBody = z.infer<typeof GetAttentionRequestResponse>;

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
  ownerToken: string;
  ownerUserId: string;
  otherToken: string;
  otherUserId: string;
  realAgentId: string;
  missingAgentId: string;
}

interface RequestOptions extends RequestInit {
  body?: string;
}

interface CreateRequestOverrides {
  userId?: string;
  agentId?: string;
  workflowId?: string;
  question?: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

function sanitizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
}

function makeWorkflowId(label: string): string {
  return `attention-${sanitizeLabel(label)}-${RUN_ID}-${randomUUID().slice(0, 8)}`;
}

async function request(
  url: string,
  options: RequestOptions = {}
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

async function createAgentViaApi(userId: string, label: string): Promise<string> {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: { status: number; data: unknown; headers: Headers };
    try {
      res = await request(`${BASE_URL}/api/agents`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'X-User-Id': userId },
        body: JSON.stringify({
          goal: `Attention black-box test agent ${label} ${RUN_ID}`,
        }),
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        console.warn(
          `[retry] createAgentViaApi attempt ${attempt}/${maxAttempts} network error: ${err}`
        );
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
    if (res.status === 201) {
      const body = res.data as { agent_id: string };
      return body.agent_id;
    }
    const isRetryable =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data &&
      (res.data as { error?: unknown }).error === 'Failed to create agent';
    if (isRetryable && attempt < maxAttempts) {
      console.warn(`[retry] createAgentViaApi attempt ${attempt}/${maxAttempts} got retryable 500`);
      await sleep(1000 * attempt + Math.random() * 500);
      continue;
    }
    throw new Error(`createAgentViaApi failed: status ${res.status}: ${JSON.stringify(res.data)}`);
  }
  throw new Error('createAgentViaApi exhausted retries');
}

async function createFixture(label: string): Promise<Fixture> {
  const owner = await createAnonymousSession(`${label}-owner`);
  const other = await createAnonymousSession(`${label}-other`);
  const missingAgentId = randomUUID();

  // Create the real agent via the backend API so it exists in the same DB
  // connection the backend will use when creating messages (avoids FK violations).
  const realAgentId = await createAgentViaApi(owner.user.id, label);

  trackedRealAgentIds.add(realAgentId);
  trackedRequestAgentIds.add(realAgentId);
  trackedRequestAgentIds.add(missingAgentId);

  return {
    label,
    ownerToken: owner.session.access_token,
    ownerUserId: owner.user.id,
    otherToken: other.session.access_token,
    otherUserId: other.user.id,
    realAgentId,
    missingAgentId,
  };
}

async function createAttentionRequest(
  fixture: Fixture,
  overrides: CreateRequestOverrides = {}
): Promise<CreateAttentionRequestBody> {
  const res = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    body: JSON.stringify({
      userId: overrides.userId || fixture.ownerUserId,
      agentId: overrides.agentId || fixture.realAgentId,
      workflowId: overrides.workflowId || makeWorkflowId(`${fixture.label}-request`),
      question: overrides.question || `Question ${randomUUID().slice(0, 8)}`,
      imageUrl: overrides.imageUrl,
      metadata: overrides.metadata,
    }),
  });
  assertStatus(res.status, 200, res.data);
  return assertSchema(CreateAttentionRequestResponse, res.data, 'POST /api/attention-requests');
}

async function getRequestById(
  id: string,
  headers: Record<string, string>
): Promise<GetAttentionRequestBody> {
  const res = await request(`${BASE_URL}/api/attention-requests/${id}`, { headers });
  assertStatus(res.status, 200, res.data);
  return assertSchema(GetAttentionRequestResponse, res.data, `GET /api/attention-requests/${id}`);
}

async function listRequests(token: string): Promise<ListAttentionRequestsBody> {
  const res = await request(`${BASE_URL}/api/attention-requests`, {
    headers: authHeaders(token),
  });
  assertStatus(res.status, 200, res.data);
  return assertSchema(ListAttentionRequestsResponse, res.data, 'GET /api/attention-requests');
}

async function getCount(token: string): Promise<number> {
  const res = await request(`${BASE_URL}/api/attention-requests/count`, {
    headers: authHeaders(token),
  });
  assertStatus(res.status, 200, res.data);
  return assertSchema(CountResponse, res.data, 'GET /api/attention-requests/count').count;
}

function listIndexById(list: ListAttentionRequestsBody, id: string): number {
  return list.requests.findIndex((request) => request.id === id);
}

async function expectLatestMessage(agentId: string, expectedText: string): Promise<void> {
  const message = await withTransientDbRetry('expectLatestMessage', () =>
    prisma.message.findFirst({
      where: { agentId, role: 'USER' },
      orderBy: { createdAt: 'desc' },
    })
  );
  assert(message, `Expected a USER message for agent ${agentId}`);
  assert(
    message.text === expectedText,
    `Expected latest USER message "${expectedText}", got "${message.text}"`
  );
}

async function countAgentMessages(agentId: string): Promise<number> {
  return withTransientDbRetry('countAgentMessages', () =>
    prisma.message.count({
      where: { agentId, role: 'USER' },
    })
  );
}

async function cleanupFixtures(): Promise<void> {
  const realAgentIds = Array.from(trackedRealAgentIds);
  const requestAgentIds = Array.from(trackedRequestAgentIds);
  const userIds = Array.from(trackedUserIds);

  if (requestAgentIds.length === 0 && userIds.length === 0) {
    return;
  }

  await withTransientDbRetry('cleanupFixtures', async () => {
    if (realAgentIds.length > 0) {
      await prisma.message.deleteMany({
        where: { agentId: { in: realAgentIds } },
      });
    }

    await prisma.agentAttentionRequest.deleteMany({
      where: {
        OR: [
          requestAgentIds.length > 0 ? { agentId: { in: requestAgentIds } } : undefined,
          userIds.length > 0 ? { userId: { in: userIds } } : undefined,
          { workflowId: { contains: RUN_ID } },
        ].filter(Boolean) as Array<Record<string, unknown>>,
      },
    });

    if (realAgentIds.length > 0) {
      await prisma.agent.deleteMany({
        where: { id: { in: realAgentIds } },
      });
    }
  });
}

async function testCreate_happyRoundTrip() {
  const fixture = await createFixture('create-happy-round-trip');
  const countBefore = await getCount(fixture.ownerToken);
  const created = await createAttentionRequest(fixture, {
    question: 'Should I proceed with the task?',
    imageUrl: 'https://example.com/diagram.png',
    metadata: { tool: 'web_search', priority: 'high' },
  });

  const requestByUser = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    requestByUser.agentId === fixture.realAgentId,
    'Created request should point at the seeded agent'
  );
  assert(
    requestByUser.question === 'Should I proceed with the task?',
    'Question should round-trip'
  );
  assert(
    requestByUser.imageUrl === 'https://example.com/diagram.png',
    'imageUrl should round-trip'
  );
  assert(
    JSON.stringify(requestByUser.metadata) ===
      JSON.stringify({ tool: 'web_search', priority: 'high' }),
    'Metadata should round-trip'
  );
  assert(requestByUser.userResponse === null, 'New request should start unanswered');

  const list = await listRequests(fixture.ownerToken);
  const listItem = list.requests.find((request) => request.id === created.id);
  assert(listItem, 'Created request should appear in the owner list');
  assert(listItem.answered === false, 'New request should be unanswered in the list response');

  const countAfter = await getCount(fixture.ownerToken);
  assert(
    countAfter === countBefore + 1,
    `Expected unanswered count ${countBefore + 1}, got ${countAfter}`
  );
}

async function testCreate_missingQuestion() {
  const fixture = await createFixture('create-missing-question');
  const res = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    body: JSON.stringify({
      userId: fixture.ownerUserId,
      agentId: fixture.realAgentId,
      workflowId: makeWorkflowId('missing-question'),
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing question)');
}

async function testCreate_emptyBody() {
  await createFixture('create-empty-body');
  const res = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 empty body)');
}

async function testCreate_emptyQuestion() {
  const fixture = await createFixture('create-empty-question');
  const res = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    body: JSON.stringify({
      userId: fixture.ownerUserId,
      agentId: fixture.realAgentId,
      workflowId: makeWorkflowId('empty-question'),
      question: '',
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 empty question)');
}

async function testCreate_invalidImageUrl() {
  const fixture = await createFixture('create-invalid-image-url');
  const res = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    body: JSON.stringify({
      userId: fixture.ownerUserId,
      agentId: fixture.realAgentId,
      workflowId: makeWorkflowId('bad-image'),
      question: 'Invalid image URL case',
      imageUrl: 'not-a-url',
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 invalid imageUrl)');
}

async function testCreate_parallelCreatesPersistBoth() {
  const fixture = await createFixture('create-parallel');
  const countBefore = await getCount(fixture.ownerToken);
  const [first, second] = await Promise.all([
    createAttentionRequest(fixture, {
      question: 'parallel-first',
      metadata: { slot: 'first' },
    }),
    createAttentionRequest(fixture, {
      question: 'parallel-second',
      metadata: { slot: 'second' },
    }),
  ]);

  const list = await listRequests(fixture.ownerToken);
  assert(
    list.requests.some((request) => request.id === first.id),
    'First parallel request should appear in list'
  );
  assert(
    list.requests.some((request) => request.id === second.id),
    'Second parallel request should appear in list'
  );

  const countAfter = await getCount(fixture.ownerToken);
  assert(
    countAfter === countBefore + 2,
    `Expected unanswered count ${countBefore + 2}, got ${countAfter}`
  );
}

async function testList_happyIsolationAndOrdering() {
  const fixture = await createFixture('list-ordering');
  const ownerFirst = await createAttentionRequest(fixture, { question: 'owner-first' });
  await sleep(25);
  const ownerSecond = await createAttentionRequest(fixture, { question: 'owner-second' });
  const otherUser = await createAttentionRequest(fixture, {
    userId: fixture.otherUserId,
    question: 'other-user',
  });

  const list = await listRequests(fixture.ownerToken);
  assert(
    list.requests.every((request) => request.id !== otherUser.id),
    'Owner list should not include another user request'
  );

  const firstIndex = listIndexById(list, ownerFirst.id);
  const secondIndex = listIndexById(list, ownerSecond.id);
  assert(firstIndex !== -1 && secondIndex !== -1, 'Owner requests should both appear in the list');
  assert(firstIndex < secondIndex, 'List should preserve oldest-first ordering before any skip');
}

async function testList_noAuth() {
  const fixture = await createFixture('list-no-auth');
  await createAttentionRequest(fixture);
  const res = await request(`${BASE_URL}/api/attention-requests`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET / (401)');
}

async function testCount_happyOnlyTracksOwnUnansweredRequests() {
  const fixture = await createFixture('count-owner-unanswered');
  const countBefore = await getCount(fixture.ownerToken);
  const answered = await createAttentionRequest(fixture, { question: 'answer-me' });
  const pending = await createAttentionRequest(fixture, { question: 'leave-me-pending' });
  await createAttentionRequest(fixture, {
    userId: fixture.otherUserId,
    question: 'other-user-pending',
  });

  const respondRes = await request(`${BASE_URL}/api/attention-requests/${answered.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: 'handled' }),
  });
  assertStatus(respondRes.status, 200, respondRes.data);
  assertSchema(ActionResponse, respondRes.data, 'POST /:id/respond');

  const countAfter = await getCount(fixture.ownerToken);
  assert(
    countAfter === countBefore + 1,
    `Expected only one new unanswered request, got count ${countAfter}`
  );

  const list = await listRequests(fixture.ownerToken);
  const pendingItem = list.requests.find((request) => request.id === pending.id);
  const answeredItem = list.requests.find((request) => request.id === answered.id);
  assert(pendingItem?.answered === false, 'Pending request should remain unanswered');
  assert(answeredItem?.answered === true, 'Answered request should be marked answered');
}

async function testCount_noAuth() {
  const fixture = await createFixture('count-no-auth');
  await createAttentionRequest(fixture);
  const res = await request(`${BASE_URL}/api/attention-requests/count`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /count (401)');
}

async function testGetById_happy() {
  const fixture = await createFixture('get-by-id-happy');
  const created = await createAttentionRequest(fixture);
  const requestByUser = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(requestByUser.id === created.id, 'GET by id should return the created request');
}

async function testGetById_apiKeyCanAccessAnyUserRequest() {
  const fixture = await createFixture('get-by-id-api-key');
  const otherUserRequest = await createAttentionRequest(fixture, {
    userId: fixture.otherUserId,
    question: 'api-key-visible',
  });
  const requestByApiKey = await getRequestById(otherUserRequest.id, apiKeyHeaders());
  assert(requestByApiKey.id === otherUserRequest.id, 'API key should fetch another user request');
}

async function testGetById_noAuth() {
  const fixture = await createFixture('get-by-id-no-auth');
  const created = await createAttentionRequest(fixture);
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:id (401)');
}

async function testGetById_notFound() {
  const fixture = await createFixture('get-by-id-not-found');
  const res = await request(`${BASE_URL}/api/attention-requests/${FAKE_UUID}`, {
    headers: authHeaders(fixture.ownerToken),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:id (404)');
}

async function testGetById_wrongUser() {
  const fixture = await createFixture('get-by-id-wrong-user');
  const created = await createAttentionRequest(fixture);
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}`, {
    headers: authHeaders(fixture.otherToken),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:id (403)');
}

async function testRespond_happyPersistsStateAndDecrementsCount() {
  const fixture = await createFixture('respond-happy');
  const countBefore = await getCount(fixture.ownerToken);
  const created = await createAttentionRequest(fixture, {
    question: 'respond-happy',
    workflowId: makeWorkflowId('respond-happy'),
  });

  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: 'Yes, go ahead' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ActionResponse, res.data, 'POST /:id/respond');

  const requestAfter = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(requestAfter.userResponse === 'Yes, go ahead', 'Respond should persist the user response');

  const countAfter = await getCount(fixture.ownerToken);
  assert(
    countAfter === countBefore,
    `Respond should restore unanswered count to ${countBefore}, got ${countAfter}`
  );

  const list = await listRequests(fixture.ownerToken);
  const listItem = list.requests.find((request) => request.id === created.id);
  assert(listItem?.answered === true, 'Responded request should be marked answered in the list');
  assert(listItem?.user_response === 'Yes, go ahead', 'List should expose the stored response');
}

async function testRespond_authLookingMetadataWithoutAuthRowIsGeneric() {
  const fixture = await createFixture('respond-auth-metadata-generic');
  const created = await createAttentionRequest(fixture, {
    question: 'auth-looking metadata',
    metadata: {
      attentionKind: 'auth_assistance',
      authAssistance: {
        requestId: 'metadata-only',
        authRealm: 'example.com',
      },
    },
  });

  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: 'metadata is not the model' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ActionResponse, res.data, 'POST /:id/respond');

  const requestAfter = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    requestAfter.userResponse === 'metadata is not the model',
    'Auth-looking metadata without a child row should be treated as a generic attention request'
  );
}

async function testRespond_noAuth() {
  const fixture = await createFixture('respond-no-auth');
  const created = await createAttentionRequest(fixture);
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    body: JSON.stringify({ response: 'Yes' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/respond (401)');
}

async function testRespond_notFound() {
  const fixture = await createFixture('respond-not-found');
  const res = await request(`${BASE_URL}/api/attention-requests/${FAKE_UUID}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: 'Yes' }),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/respond (404)');
}

async function testRespond_badInput() {
  const fixture = await createFixture('respond-bad-input');
  const created = await createAttentionRequest(fixture, { question: 'respond-bad-input' });
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/respond (400)');
}

async function testRespond_wrongUser() {
  const fixture = await createFixture('respond-wrong-user');
  const created = await createAttentionRequest(fixture, { question: 'respond-wrong-user' });
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.otherToken),
    body: JSON.stringify({ response: 'Yes' }),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/respond (403)');
}

async function testRespond_repeatOverwritesExistingResponse() {
  const fixture = await createFixture('respond-repeat');
  const created = await createAttentionRequest(fixture, { question: 'respond-repeat' });

  const first = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: 'first response' }),
  });
  assertStatus(first.status, 200, first.data);

  const second = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: 'second response' }),
  });
  assertStatus(second.status, 200, second.data);

  const requestAfter = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    requestAfter.userResponse === 'second response',
    'Repeated respond should overwrite the stored response'
  );
}

async function testSkip_happyMovesRequestToBackWithoutChangingCount() {
  const fixture = await createFixture('skip-happy');
  const countBefore = await getCount(fixture.ownerToken);
  const first = await createAttentionRequest(fixture, { question: 'skip-first' });
  await sleep(25);
  const second = await createAttentionRequest(fixture, { question: 'skip-second' });

  const listBefore = await listRequests(fixture.ownerToken);
  const firstIndexBefore = listIndexById(listBefore, first.id);
  const secondIndexBefore = listIndexById(listBefore, second.id);
  assert(
    firstIndexBefore !== -1 && secondIndexBefore !== -1,
    'Skip fixture requests should appear in the list'
  );
  assert(
    firstIndexBefore < secondIndexBefore,
    'First request should start ahead of the second request'
  );

  const firstBefore = await getRequestById(first.id, authHeaders(fixture.ownerToken));
  const res = await request(`${BASE_URL}/api/attention-requests/${first.id}/skip`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ActionResponse, res.data, 'POST /:id/skip');

  const listAfter = await listRequests(fixture.ownerToken);
  const firstIndexAfter = listIndexById(listAfter, first.id);
  const secondIndexAfter = listIndexById(listAfter, second.id);
  assert(
    secondIndexAfter < firstIndexAfter,
    'Skipped request should move behind newer pending requests'
  );

  const firstAfter = await getRequestById(first.id, authHeaders(fixture.ownerToken));
  assert(
    new Date(String(firstAfter.updatedAt)).getTime() >
      new Date(String(firstBefore.updatedAt)).getTime(),
    'Skip should advance updatedAt'
  );

  const countAfter = await getCount(fixture.ownerToken);
  assert(
    countAfter === countBefore + 2,
    `Skip should not change unanswered count; expected ${countBefore + 2}, got ${countAfter}`
  );
}

async function testSkip_noAuth() {
  const fixture = await createFixture('skip-no-auth');
  const created = await createAttentionRequest(fixture);
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/skip`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/skip (401)');
}

async function testSkip_notFound() {
  const fixture = await createFixture('skip-not-found');
  const res = await request(`${BASE_URL}/api/attention-requests/${FAKE_UUID}/skip`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/skip (404)');
}

async function testSkip_wrongUser() {
  const fixture = await createFixture('skip-wrong-user');
  const created = await createAttentionRequest(fixture, { question: 'skip-wrong-user' });
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/skip`, {
    method: 'POST',
    headers: authHeaders(fixture.otherToken),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/skip (403)');
}

async function testReject_happyPersistsRejectedState() {
  const fixture = await createFixture('reject-happy');
  const countBefore = await getCount(fixture.ownerToken);
  const created = await createAttentionRequest(fixture, { question: 'reject-happy' });

  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/reject`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ActionResponse, res.data, 'POST /:id/reject');

  const requestAfter = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    requestAfter.userResponse === '__REJECTED__',
    'Reject should persist the rejection marker'
  );

  const countAfter = await getCount(fixture.ownerToken);
  assert(
    countAfter === countBefore,
    `Reject should restore unanswered count to ${countBefore}, got ${countAfter}`
  );
}

async function testReject_withMessageCreatesTrimmedUserMessage() {
  const fixture = await createFixture('reject-with-message');
  const beforeMessages = await countAgentMessages(fixture.realAgentId);
  const created = await createAttentionRequest(fixture, {
    question: 'reject-with-message',
    agentId: fixture.realAgentId,
  });

  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/reject`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ message: '  Do not proceed with this  ' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ActionResponse, res.data, 'POST /:id/reject (with message)');

  const afterMessages = await countAgentMessages(fixture.realAgentId);
  assert(
    afterMessages === beforeMessages + 1,
    `Expected one new agent message, got count ${afterMessages}`
  );
  await expectLatestMessage(fixture.realAgentId, 'Do not proceed with this');

  const requestAfter = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    requestAfter.userResponse === '__REJECTED__',
    'Reject with message should still mark the request rejected'
  );
}

async function testReject_blankMessageDoesNotCreateSideEffect() {
  const fixture = await createFixture('reject-blank-message');
  const beforeMessages = await countAgentMessages(fixture.realAgentId);
  const created = await createAttentionRequest(fixture, {
    question: 'reject-blank-message',
    agentId: fixture.realAgentId,
  });

  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/reject`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ message: '   ' }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ActionResponse, res.data, 'POST /:id/reject (blank message)');

  const afterMessages = await countAgentMessages(fixture.realAgentId);
  assert(
    afterMessages === beforeMessages,
    'Blank rejection message should not create an agent message'
  );

  const requestAfter = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    requestAfter.userResponse === '__REJECTED__',
    'Blank rejection message should still reject the request'
  );
}

async function testReject_missingAgentWithMessageCharacterizesFailure() {
  const fixture = await createFixture('reject-missing-agent');
  const countBefore = await getCount(fixture.ownerToken);
  const created = await createAttentionRequest(fixture, {
    question: 'reject-missing-agent',
    agentId: fixture.missingAgentId,
  });

  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/reject`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ message: 'This will fail because the agent is missing' }),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/reject (500 missing agent)');

  const requestAfter = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    requestAfter.userResponse === null,
    'Failed rejection should leave the request unanswered'
  );

  const countAfter = await getCount(fixture.ownerToken);
  assert(
    countAfter === countBefore + 1,
    `Failed rejection should keep unanswered count at ${countBefore + 1}, got ${countAfter}`
  );
}

async function testReject_noAuth() {
  const fixture = await createFixture('reject-no-auth');
  const created = await createAttentionRequest(fixture);
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/reject`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/reject (401)');
}

async function testReject_notFound() {
  const fixture = await createFixture('reject-not-found');
  const res = await request(`${BASE_URL}/api/attention-requests/${FAKE_UUID}/reject`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/reject (404)');
}

async function testReject_wrongUser() {
  const fixture = await createFixture('reject-wrong-user');
  const created = await createAttentionRequest(fixture, { question: 'reject-wrong-user' });
  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/reject`, {
    method: 'POST',
    headers: authHeaders(fixture.otherToken),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/reject (403)');
}

async function runAll() {
  console.log('Attention Requests Contract Tests');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`Execution mode: isolated fixtures with caseConcurrency=${CASE_CONCURRENCY}`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'POST / (create)',
      tests: [
        { name: 'happy path + round-trip', fn: testCreate_happyRoundTrip },
        { name: 'missing question', fn: testCreate_missingQuestion },
        { name: 'empty body', fn: testCreate_emptyBody },
        { name: 'empty question string', fn: testCreate_emptyQuestion },
        { name: 'invalid imageUrl', fn: testCreate_invalidImageUrl },
        {
          name: 'parallel create persists both requests',
          fn: testCreate_parallelCreatesPersistBoth,
        },
      ],
    },
    {
      name: 'GET / (list)',
      tests: [
        { name: 'owner isolation + oldest-first ordering', fn: testList_happyIsolationAndOrdering },
        { name: 'no auth -> 401', fn: testList_noAuth },
      ],
    },
    {
      name: 'GET /count',
      tests: [
        {
          name: 'tracks only owner unanswered requests',
          fn: testCount_happyOnlyTracksOwnUnansweredRequests,
        },
        { name: 'no auth -> 401', fn: testCount_noAuth },
      ],
    },
    {
      name: 'GET /:id',
      tests: [
        { name: 'happy path (JWT)', fn: testGetById_happy },
        {
          name: 'API key can access any user request',
          fn: testGetById_apiKeyCanAccessAnyUserRequest,
        },
        { name: 'no auth -> 401', fn: testGetById_noAuth },
        { name: 'not found -> 404', fn: testGetById_notFound },
        { name: 'wrong user -> 403', fn: testGetById_wrongUser },
      ],
    },
    {
      name: 'POST /:id/respond',
      tests: [
        {
          name: 'happy path persists state and decrements count',
          fn: testRespond_happyPersistsStateAndDecrementsCount,
        },
        {
          name: 'auth-looking metadata without child row responds generically',
          fn: testRespond_authLookingMetadataWithoutAuthRowIsGeneric,
        },
        { name: 'no auth -> 401', fn: testRespond_noAuth },
        { name: 'not found -> 404', fn: testRespond_notFound },
        { name: 'bad input -> 400', fn: testRespond_badInput },
        { name: 'wrong user -> 403', fn: testRespond_wrongUser },
        {
          name: 'repeat respond overwrites previous response',
          fn: testRespond_repeatOverwritesExistingResponse,
        },
      ],
    },
    {
      name: 'POST /:id/skip',
      tests: [
        {
          name: 'happy path reorders queue without changing count',
          fn: testSkip_happyMovesRequestToBackWithoutChangingCount,
        },
        { name: 'no auth -> 401', fn: testSkip_noAuth },
        { name: 'not found -> 404', fn: testSkip_notFound },
        { name: 'wrong user -> 403', fn: testSkip_wrongUser },
      ],
    },
    {
      name: 'POST /:id/reject',
      tests: [
        { name: 'happy path persists rejected state', fn: testReject_happyPersistsRejectedState },
        {
          name: 'with message creates one trimmed USER message',
          fn: testReject_withMessageCreatesTrimmedUserMessage,
        },
        {
          name: 'blank message creates no side effect',
          fn: testReject_blankMessageDoesNotCreateSideEffect,
        },
        {
          name: 'missing agent + message returns 500 and keeps request pending',
          fn: testReject_missingAgentWithMessageCharacterizesFailure,
        },
        { name: 'no auth -> 401', fn: testReject_noAuth },
        { name: 'not found -> 404', fn: testReject_notFound },
        { name: 'wrong user -> 403', fn: testReject_wrongUser },
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
    const passed = allResults.filter((result) => result.passed).length;
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

    console.log('\nAll attention-request black-box tests passed.');
    process.exitCode = 0;
  } finally {
    await cleanupFixtures();
  }
}

runAll().catch(async (error) => {
  console.error('\nAttention request contract suite crashed:', error);
  try {
    await cleanupFixtures();
  } catch (cleanupError) {
    console.error('Cleanup failed:', cleanupError);
  }
  process.exit(1);
});
