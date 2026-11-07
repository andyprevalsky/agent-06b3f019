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
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import { appendGateWaiter, findPendingByGateKey } from '../../domains/attention-requests/repo';
import { resolveAndSignal } from '../../providers/gateResolution';
import { getTemporalClient } from '../../providers/temporal';
import { blackboxTemporalSignals } from '../../providers/temporalBlackboxFake';
import { AttentionWorkflowTargetOwnershipError } from '../../providers/attentionWorkflowTargets';

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
const execFileAsync = promisify(execFile);

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

function makeWorkflowId(label: string, agentId?: string): string {
  if (agentId !== undefined) return `${agentId}:replacement:${randomUUID()}`;
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
      // Creation fixtures represent internal worker calls; adversarial callers
      // supply explicit headers so they never inherit this credential.
      ...(url === `${BASE_URL}/api/attention-requests` &&
      options.method === 'POST' &&
      options.headers === undefined
        ? { 'X-API-Key': API_KEY }
        : {}),
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
  let agentId = overrides.agentId || fixture.realAgentId;
  if (
    overrides.userId !== undefined &&
    overrides.userId !== fixture.ownerUserId &&
    overrides.agentId === undefined
  ) {
    const otherAgent = await prisma.agent.create({
      data: {
        userId: overrides.userId,
        goal: 'Attention owner isolation fixture',
        status: 'ACTIVE',
      },
    });
    trackedRealAgentIds.add(otherAgent.id);
    agentId = otherAgent.id;
  }
  // Missing-agent cases exercise historical corrupt rows, which authenticated
  // creation now rejects before they can enter the database.
  if (overrides.agentId === fixture.missingAgentId) {
    const row = await prisma.agentAttentionRequest.create({
      data: {
        userId: overrides.userId || fixture.ownerUserId,
        agentId: fixture.missingAgentId,
        workflowId: fixture.missingAgentId,
        question: overrides.question || 'Legacy missing agent',
        metadata: overrides.metadata,
      },
    });
    return { id: row.id, created_at: row.createdAt, metadata: row.metadata };
  }
  const res = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    body: JSON.stringify({
      userId: overrides.userId || fixture.ownerUserId,
      agentId,
      workflowId: overrides.workflowId || agentId,
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

async function createPendingApprovalMessage(agentId: string, requestId: string): Promise<string> {
  const message = await prisma.message.create({
    data: {
      agentId,
      text: 'Approve this action?',
      role: 'TOOL',
      metadata: {
        isUserAttentionMessage: true,
        toolCallId: `approval-tool-${randomUUID()}`,
        toolName: 'request_user_approval',
        toolStatus: 'IN_PROGRESS',
        requestUserApproval: { toolApproval: true, attentionRequestId: requestId },
      },
    },
  });
  return message.id;
}

async function expectApprovalMessageFinished(messageId: string): Promise<void> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  const metadata = message?.metadata as { toolStatus?: unknown } | null;
  assert(
    metadata?.toolStatus === 'FINISHED',
    `Resolved approval message should be FINISHED, got ${String(metadata?.toolStatus)}`
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

async function testCreate_externalCallerCannotWriteAuthoredInputToForeignAgent() {
  const fixture = await createFixture('foreign-attention-attack');
  const created = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    headers: authHeaders(fixture.otherToken),
    body: JSON.stringify({
      userId: fixture.otherUserId,
      agentId: fixture.realAgentId,
      workflowId: makeWorkflowId('foreign-attack'),
      question: 'Foreign authored reply attack',
    }),
  });
  let responseStatus: number | undefined;
  let foreignWrites = 0;
  if (created.status === 200) {
    const id = String((created.data as { id: string }).id);
    const answered = await request(`${BASE_URL}/api/attention-requests/${id}/respond`, {
      method: 'POST',
      headers: authHeaders(fixture.otherToken),
      body: JSON.stringify({ response: 'Approved', user_message: 'Unauthorized authored input' }),
    });
    responseStatus = answered.status;
    foreignWrites = await prisma.message.count({
      where: {
        agentId: fixture.realAgentId,
        role: 'USER',
        metadata: { path: ['attentionRequestId'], equals: id },
      },
    });
  }
  assert(
    created.status === 403 && foreignWrites === 0,
    `Own-JWT foreign-agent attack must be denied: create=${created.status}, respond=${responseStatus}, foreign_USER_writes=${foreignWrites}`
  );
}

async function testRespond_legacyForeignPrimaryAndWaiterCannotReceiveAuthoredInput(
  foreignPrimary: boolean
) {
  const fixture = await createFixture('legacy-foreign-attention');
  const ownAgent = await prisma.agent.create({
    data: { userId: fixture.otherUserId, goal: 'Owned attention agent', status: 'ACTIVE' },
  });
  trackedRealAgentIds.add(ownAgent.id);
  const row = await prisma.agentAttentionRequest.create({
    data: {
      userId: fixture.otherUserId,
      agentId: foreignPrimary ? fixture.realAgentId : ownAgent.id,
      workflowId: makeWorkflowId('legacy-foreign'),
      question: 'Legacy crafted row',
      metadata: foreignPrimary
        ? {}
        : {
            gateWaiters: [
              { agentId: fixture.realAgentId, workflowId: makeWorkflowId('foreign-waiter') },
            ],
          },
    },
  });
  const answered = await request(`${BASE_URL}/api/attention-requests/${row.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.otherToken),
    body: JSON.stringify({ response: 'Approved', user_message: 'Unauthorized legacy input' }),
  });
  const persisted = await prisma.agentAttentionRequest.findUniqueOrThrow({ where: { id: row.id } });
  const writes = await prisma.message.count({
    where: { role: 'USER', metadata: { path: ['attentionRequestId'], equals: row.id } },
  });
  assert(
    answered.status === 403 && persisted.userResponse === null && writes === 0,
    `Legacy foreign ${foreignPrimary ? 'primary' : 'waiter'} must fail atomically: status=${answered.status}, response=${persisted.userResponse}, USER_writes=${writes}`
  );
}

async function testCreate_requiresAuthentication() {
  const fixture = await createFixture('create-auth-required');
  const result = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      userId: fixture.ownerUserId,
      agentId: fixture.realAgentId,
      workflowId: makeWorkflowId('no-auth'),
      question: 'Unauthenticated',
    }),
  });
  assertStatus(result.status, 401, result.data);
}

async function testCreate_ownedAgentCannotTargetForeignWorkflow(asWaiter: boolean) {
  const fixture = await createFixture('foreign-workflow-attack');
  const foreign = await prisma.agent.create({
    data: { userId: fixture.otherUserId, goal: 'Foreign workflow target', status: 'ACTIVE' },
  });
  trackedRealAgentIds.add(foreign.id);
  await prisma.agent.update({
    where: { id: foreign.id },
    data: { temporalWorkflowId: foreign.id },
  });
  const temporal = await getTemporalClient();
  await temporal.workflow.start('AgentWorkflow', {
    workflowId: foreign.id,
    taskQueue: 'blackbox',
    args: [foreign.id, fixture.otherUserId],
  });
  await temporal.workflow.start('AgentWorkflow', {
    workflowId: fixture.realAgentId,
    taskQueue: 'blackbox',
    args: [fixture.realAgentId, fixture.ownerUserId],
  });
  const created = await request(`${BASE_URL}/api/attention-requests`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({
      userId: fixture.ownerUserId,
      agentId: fixture.realAgentId,
      workflowId: asWaiter ? fixture.realAgentId : foreign.id,
      question: 'Foreign workflow target',
      metadata: asWaiter
        ? { gateWaiters: [{ agentId: fixture.realAgentId, workflowId: foreign.id }] }
        : {},
    }),
  });
  let providerError: unknown;
  if (created.status === 200) {
    const id = String((created.data as { id: string }).id);
    const row = await prisma.agentAttentionRequest.findUniqueOrThrow({ where: { id } });
    try {
      await resolveAndSignal(row, 'Approved', 'Unauthorized workflow instruction');
    } catch (error) {
      providerError = error;
    }
  }
  const legacy = await prisma.agentAttentionRequest.create({
    data: {
      userId: fixture.ownerUserId,
      agentId: fixture.realAgentId,
      workflowId: asWaiter ? fixture.realAgentId : foreign.id,
      question: 'Legacy foreign workflow',
      metadata: asWaiter
        ? { gateWaiters: [{ agentId: fixture.realAgentId, workflowId: foreign.id }] }
        : {},
    },
  });
  let legacyError: unknown;
  try {
    await resolveAndSignal(legacy, 'Approved', 'Unauthorized legacy workflow instruction');
  } catch (error) {
    legacyError = error;
  }
  const legacyAfter = await prisma.agentAttentionRequest.findUniqueOrThrow({
    where: { id: legacy.id },
  });
  const legacyWrites = await prisma.message.count({
    where: { metadata: { path: ['attentionRequestId'], equals: legacy.id } },
  });
  const foreignSignals = blackboxTemporalSignals(temporal, foreign.id).filter(
    (signal) => signal.name === 'receive_user_response'
  );
  assert(
    created.status === 403 && foreignSignals.length === 0,
    `Own-agent foreign ${asWaiter ? 'waiter' : 'primary'} workflow must be denied: create=${created.status}, foreign_signals=${foreignSignals.length}, provider_error=${providerError instanceof Error ? providerError.message : 'none'}`
  );
  assert(
    legacyError instanceof AttentionWorkflowTargetOwnershipError &&
      legacyAfter.userResponse === null &&
      legacyWrites === 0,
    'Legacy foreign workflow must reject before any USER write, control commit, or signal'
  );
}

async function testCreate_preservesLegitimateWorkerAndExternalWorkflowBindings() {
  const fixture = await createFixture('owned-workflow-bindings');
  const current = `legacy-current-${randomUUID()}`;
  const stale = `legacy-stale-${randomUUID()}`;
  const agent = await prisma.agent.create({
    data: {
      userId: fixture.ownerUserId,
      goal: 'Owned workflow bindings',
      temporalWorkflowId: current,
      staleTemporalWorkflowId: stale,
    },
  });
  trackedRealAgentIds.add(agent.id);
  for (const headers of [authHeaders(fixture.ownerToken), apiKeyHeaders()]) {
    for (const workflowId of [
      agent.id,
      current,
      stale,
      makeWorkflowId('native-replacement', agent.id),
    ]) {
      const result = await request(`${BASE_URL}/api/attention-requests`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: fixture.ownerUserId,
          agentId: agent.id,
          workflowId,
          question: 'Legitimate bound workflow',
        }),
      });
      assertStatus(result.status, 200, result.data);
    }
  }
}

async function testCreate_actualWorkerProducerAuthenticates(
  producer: 'gate' | 'approval',
  caller: 'owned' | 'foreign' | 'missing-key'
) {
  const fixture = await createFixture(`worker-${producer}-${caller}`);
  const agentsDir = resolve(__dirname, '../../../../agents');
  const userId = caller === 'foreign' ? fixture.otherUserId : fixture.ownerUserId;
  const { stdout } = await execFileAsync(
    resolve(agentsDir, 'venv/bin/python'),
    [
      resolve(agentsDir, 'tests/blackbox/attention_request_http_fixture.py'),
      producer,
      userId,
      fixture.realAgentId,
      fixture.realAgentId,
    ],
    {
      cwd: agentsDir,
      env: {
        ...process.env,
        PYTHONPATH: agentsDir,
        BACKEND_API_URL: BASE_URL,
        BACKEND_API_KEY: caller === 'missing-key' ? '' : API_KEY,
      },
    }
  );
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
    request_id?: string;
    status: number;
  };
  assertStatus(result.status, caller === 'owned' ? 200 : caller === 'foreign' ? 403 : 401, result);
  const rows = await prisma.agentAttentionRequest.findMany({
    where: { agentId: fixture.realAgentId },
  });
  if (caller !== 'owned') {
    assert(rows.length === 0, 'Rejected worker request must not create attention state');
    return;
  }
  assert(
    rows.length === 1 &&
      rows[0]?.id === result.request_id &&
      rows[0]?.userId === userId &&
      rows[0]?.workflowId === fixture.realAgentId &&
      rows[0]?.userResponse === null,
    'Actual worker producer must preserve its owned pending request'
  );
  if (producer === 'gate') assert(rows[0]?.gateKey === 'subscription', 'Credit gate identity lost');
}

async function testAuthCompletion_legacyForeignAgentIsForbiddenAtomically(
  mismatchedParentUser = false
) {
  const fixture = await createFixture('legacy-foreign-auth');
  const attention = await prisma.agentAttentionRequest.create({
    data: {
      userId: mismatchedParentUser ? fixture.ownerUserId : fixture.otherUserId,
      agentId: fixture.realAgentId,
      workflowId: fixture.realAgentId,
      question: 'Legacy foreign auth request',
    },
  });
  await prisma.userAuthAssistanceRequest.create({
    data: {
      id: attention.id,
      userId: fixture.otherUserId,
      agentId: fixture.realAgentId,
      authRealm: 'example.com',
      mode: 'manual_step',
      steelSessionId: '',
    },
  });
  const completed = await request(`${BASE_URL}/api/auth-assistance/${attention.id}/complete`, {
    method: 'POST',
    headers: authHeaders(fixture.otherToken),
  });
  assertStatus(completed.status, 403, completed.data);
  const row = await prisma.agentAttentionRequest.findUniqueOrThrow({ where: { id: attention.id } });
  const auth = await prisma.userAuthAssistanceRequest.findUniqueOrThrow({
    where: { id: attention.id },
  });
  assert(
    row.userResponse === null && auth.completedAt === null,
    'Foreign auth completion must roll back its protocol and completion claims'
  );
  assert(
    (await prisma.message.count({
      where: {
        role: 'USER',
        metadata: { path: ['attentionRequestId'], equals: attention.id },
      },
    })) === 0,
    'Foreign auth completion must not create a USER message'
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

// Gate fan-in dedup: multiple agents that hit the same gate (same userId +
// gateKey) collapse onto ONE pending AttentionRequest instead of spamming the
// user with duplicates. See docs/plans/active/sms-onboarding-and-gates.md.
async function testCreate_gateDedupCollapsesToOnePendingRequest() {
  const fixture = await createFixture('create-gate-dedup');
  const gateKey = `subscription:${RUN_ID}:${randomUUID().slice(0, 8)}`;

  async function postGate(
    key: string,
    workflowLabel: string
  ): Promise<{ id: string; deduped?: boolean }> {
    const res = await request(`${BASE_URL}/api/attention-requests`, {
      method: 'POST',
      body: JSON.stringify({
        userId: fixture.ownerUserId,
        agentId: fixture.realAgentId,
        workflowId: makeWorkflowId(`${fixture.label}-${workflowLabel}`, fixture.realAgentId),
        question: 'Subscribe to continue',
        gateKey: key,
        metadata: {
          gate: {
            gateKey: key,
            type: 'subscription',
            status: 'PENDING',
            severity: 'blocking',
            presentation: {
              title: 'Subscribe to continue',
              reason: 'Out of free credit',
              cta: 'Subscribe',
            },
            action: {
              kind: 'link',
              url: 'https://roselabs.ai/s/x',
              expiresAt: '2026-01-01T00:00:00Z',
            },
            detection: { method: 'stripe_webhook', probeKey: 'subscription' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    return res.data as { id: string; deduped?: boolean };
  }

  // Two sub-agents (distinct workflows) hit the same gate → ONE request.
  const first = await postGate(gateKey, 'wf-a');
  const second = await postGate(gateKey, 'wf-b');
  assert(first.deduped !== true, 'First gate should create a fresh request');
  assert(second.deduped === true, 'Second gate should dedup (deduped=true)');
  assert(
    second.id === first.id,
    `Second gate should reuse the first id (${first.id} vs ${second.id})`
  );

  const pending = await prisma.agentAttentionRequest.count({
    where: { userId: fixture.ownerUserId, gateKey, userResponse: null },
  });
  assert(pending === 1, `Expected exactly one pending gate row, got ${pending}`);

  // A different gateKey is a distinct gate.
  const otherKey = `kyc:${RUN_ID}:${randomUUID().slice(0, 8)}`;
  const other = await postGate(otherKey, 'wf-c');
  assert(other.id !== first.id, 'A different gateKey must create a new request');
  assert(other.deduped !== true, 'A different gateKey must not dedup');

  // Once the pending gate is answered, the same key no longer dedups — a fresh
  // gate can be raised (a later run may need the user to act again).
  await prisma.agentAttentionRequest.update({
    where: { id: first.id },
    data: { userResponse: 'RESOLVED' },
  });
  const third = await postGate(gateKey, 'wf-d');
  assert(
    third.id !== first.id,
    'After the pending gate is answered, a new request should be created'
  );
  assert(third.deduped !== true, 'Post-resolution gate should not dedup');
}

// Resolve-all-waiters: when a second agent dedups onto a gate it is recorded as
// a waiter, and resolving the gate resumes the primary + every waiter.
async function testCreate_gateResolveSignalsAllWaiters() {
  const fixture = await createFixture('gate-waiters');
  const gateKey = `subscription:${RUN_ID}:${randomUUID().slice(0, 8)}`;
  const wfA = makeWorkflowId(`${fixture.label}-wf-a`, fixture.realAgentId);
  const wfB = makeWorkflowId(`${fixture.label}-wf-b`, fixture.realAgentId);

  async function postGate(workflowId: string): Promise<{ id: string; deduped?: boolean }> {
    const res = await request(`${BASE_URL}/api/attention-requests`, {
      method: 'POST',
      body: JSON.stringify({
        userId: fixture.ownerUserId,
        agentId: fixture.realAgentId,
        workflowId,
        question: 'Subscribe to continue',
        gateKey,
        metadata: {
          gate: {
            gateKey,
            type: 'subscription',
            status: 'PENDING',
            severity: 'blocking',
            presentation: { title: 'Subscribe', reason: 'Out of credit', cta: 'Subscribe' },
            action: { kind: 'link', url: 'https://roselabs.ai/s/x' },
            detection: { method: 'stripe_webhook', probeKey: 'subscription' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    return res.data as { id: string; deduped?: boolean };
  }

  const first = await postGate(wfA);
  const second = await postGate(wfB);
  assert(second.id === first.id, 'Second agent should dedup onto the same gate');

  const row = await prisma.agentAttentionRequest.findUnique({ where: { id: first.id } });
  assert(row !== null, 'Gate request should exist');
  assert(row.workflowId === wfA, 'Primary workflow should be the first agent (wf-a)');
  const meta = row.metadata as { gateWaiters?: Array<{ workflowId: string }> } | null;
  const waiters = meta?.gateWaiters ?? [];
  assert(
    waiters.some((w) => w.workflowId === wfB),
    `Second agent (wf-b) should be recorded as a waiter; got ${JSON.stringify(waiters)}`
  );
  assert(
    !waiters.some((w) => w.workflowId === wfA),
    'Primary workflow must not be duplicated into the waiter list'
  );

  // Resolving succeeds (the service signals primary + every waiter).
  const respondRes = await request(`${BASE_URL}/api/attention-requests/${first.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: 'resolved' }),
  });
  assertStatus(respondRes.status, 200, respondRes.data);
}

// One minimal SMS action: a gate raised for an SMS-source agent renders exactly
// one tap (link) or one reply, texted to the user.
async function testCreate_gateSmsRendersOneMinimalAction() {
  const userId = `bb-gate-sms-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  const phone = `+1925${Math.floor(1000000 + Math.random() * 8999999)}`;
  trackedUserIds.add(userId);
  await prisma.user.create({ data: { userId, phone, isAnonymous: false } });
  const agent = await prisma.agent.create({
    data: { userId, goal: 'gate sms test', status: 'ACTIVE', source: 'SMS' },
  });
  trackedRequestAgentIds.add(agent.id);

  try {
    const url = 'https://roselabs.ai/s/onetap';
    const res = await request(`${BASE_URL}/api/attention-requests`, {
      method: 'POST',
      body: JSON.stringify({
        userId,
        agentId: agent.id,
        workflowId: makeWorkflowId('gate-sms', agent.id),
        question: 'Subscribe to continue',
        gateKey: `subscription:${RUN_ID}:${randomUUID().slice(0, 8)}`,
        metadata: {
          gate: {
            gateKey: `subscription:${RUN_ID}`,
            type: 'subscription',
            status: 'PENDING',
            severity: 'blocking',
            presentation: {
              title: 'Subscribe to finish your task',
              reason: 'Out of free credit',
              cta: 'Subscribe',
            },
            action: { kind: 'link', url },
            detection: { method: 'stripe_webhook', probeKey: 'subscription' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const data = res.data as { gateSms?: string };
    assert(typeof data.gateSms === 'string', 'Gate for an SMS agent should render an SMS body');
    assert(
      (data.gateSms ?? '').includes(url),
      `SMS should carry the single action link; got "${data.gateSms}"`
    );
    assert(
      !(data.gateSms ?? '').includes('\n'),
      `SMS should be one minimal line; got "${data.gateSms}"`
    );
  } finally {
    await prisma.agentAttentionRequest.deleteMany({ where: { agentId: agent.id } });
    await prisma.agent.deleteMany({ where: { id: agent.id } });
    await prisma.user.deleteMany({ where: { userId } });
  }
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

/**
 * Archive is soft-delete. Even if a delete path forgets to wipe attention rows,
 * list/count must not keep prompting for an agent the user can no longer open.
 */
async function testList_excludesArchivedAgentRequests() {
  const fixture = await createFixture('list-excludes-archived');
  const live = await createAttentionRequest(fixture, { question: 'still-live' });
  const doomed = await createAttentionRequest(fixture, { question: 'about-to-archive' });

  await withTransientDbRetry('soft-delete-agent-for-list', async () => {
    await prisma.agent.update({
      where: { id: fixture.realAgentId },
      data: { deletedAt: new Date() },
    });
  });

  // Recreate a live agent so the fixture still has an active owner agent; the
  // doomed request stays pointed at the archived agentId.
  const replacementId = await createAgentViaApi(fixture.ownerUserId, 'list-excludes-live');
  trackedRealAgentIds.add(replacementId);
  trackedRequestAgentIds.add(replacementId);
  await withTransientDbRetry('repoint-live-attention', async () => {
    await prisma.agentAttentionRequest.update({
      where: { id: live.id },
      data: { agentId: replacementId },
    });
  });

  const list = await listRequests(fixture.ownerToken);
  assert(
    list.requests.some((request) => request.id === live.id),
    'Live agent request should remain listed'
  );
  assert(
    list.requests.every((request) => request.id !== doomed.id),
    'Archived agent request must be hidden from the inbox list'
  );

  const count = await getCount(fixture.ownerToken);
  const listedUnanswered = list.requests.filter((request) => !request.answered).length;
  assert(
    count === listedUnanswered,
    `Count (${count}) must match listed unanswered (${listedUnanswered}) after archive hide`
  );
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
    workflowId: makeWorkflowId('respond-happy', fixture.realAgentId),
  });
  const approvalMessageId = await createPendingApprovalMessage(fixture.realAgentId, created.id);

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
  await expectApprovalMessageFinished(approvalMessageId);
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

async function testRespond_authoredMessagePersistsExactlyOnceWithOriginalBytes() {
  const fixture = await createFixture('respond-authored');
  const created = await createAttentionRequest(fixture);
  const beforeMessages = await prisma.message.findMany({
    where: { agentId: fixture.realAgentId, role: 'USER' },
    select: { id: true },
  });
  const text = '  Return only venue_prices\nKeep these exact bytes.  ';
  const send = (userMessage: string) =>
    request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
      method: 'POST',
      headers: authHeaders(fixture.ownerToken),
      body: JSON.stringify({ response: text, user_message: userMessage }),
    });
  const responses = await Promise.all([send(text), send(text)]);
  for (const response of responses) assertStatus(response.status, 200, response.data);
  const retried = await send(text);
  assertStatus(retried.status, 200, retried.data);
  const messages = await prisma.message.findMany({
    where: {
      agentId: fixture.realAgentId,
      role: 'USER',
      id: { notIn: beforeMessages.map(({ id }) => id) },
    },
  });
  assert(
    messages.length === 1,
    `Expected one authored USER row after concurrent/repeated replies, got ${messages.length}`
  );
  assert(
    messages[0].text === text,
    'Authored attention response must preserve every original byte'
  );
  // The authored reply is a person's message: it moves the sidebar recency key
  // (stamped after commit, so read until it lands).
  const stamped = await retryWithBackoff(
    async () =>
      (
        await prisma.agent.findUnique({
          where: { id: fixture.realAgentId },
          select: { lastUserMessageAt: true },
        })
      )?.lastUserMessageAt ?? null,
    {
      maxRetries: 8,
      initialBackoffMs: 100,
      shouldRetryResult: (at) => at === null,
      component: 'AttentionReplyStamp',
    }
  );
  assert(
    stamped?.getTime() === messages[0].timestamp.getTime(),
    `Authored reply should stamp lastUserMessageAt, got ${stamped?.toISOString() ?? 'null'}`
  );
}

async function testRespond_authoredInputAfterControlIsPreservedAndConflictsAreExplicit() {
  const fixture = await createFixture('respond-authored-after-control');
  const initialCount = await countAgentMessages(fixture.realAgentId);
  const created = await createAttentionRequest(fixture);
  const send = (body: object) =>
    request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
      method: 'POST',
      headers: authHeaders(fixture.ownerToken),
      body: JSON.stringify(body),
    });
  const control = await send({ response: 'Approved' });
  assertStatus(control.status, 200, control.data);
  const text = '  Return only venue_prices after the button approval.  ';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await send({ response: text.trim(), user_message: text });
    assertStatus(result.status, 200, result.data);
  }
  const rows = await prisma.message.findMany({
    where: {
      agentId: fixture.realAgentId,
      role: 'USER',
      metadata: { path: ['attentionRequestId'], equals: created.id },
    },
  });
  assert(
    rows.length === 1 && rows[0].text === text,
    'A control-first race must preserve the first authored reply once'
  );
  const conflict = await send({
    response: 'A distinct later message',
    user_message: 'A distinct later message',
  });
  assertStatus(conflict.status, 409, conflict.data);
  assert(
    (await countAgentMessages(fixture.realAgentId)) === initialCount + 1,
    'Conflicting reply must not add USER input'
  );
  const persisted = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    persisted.userResponse === 'Approved',
    'Authored input must not overwrite the accepted protocol decision'
  );
}

async function testRespond_controlsAndNarrativesDoNotBecomeUserMessages() {
  const fixture = await createFixture('respond-controls');
  const beforeMessages = await countAgentMessages(fixture.realAgentId);
  for (const response of ['Approved', 'Message sent via Mac app ✅', 'Authentication complete']) {
    const created = await createAttentionRequest(fixture);
    const result = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
      method: 'POST',
      headers: authHeaders(fixture.ownerToken),
      body: JSON.stringify({ response }),
    });
    assertStatus(result.status, 200, result.data);
  }
  const messages = await prisma.message.count({
    where: { agentId: fixture.realAgentId, role: 'USER' },
  });
  assert(
    messages === beforeMessages,
    'Controls and completion narratives must not manufacture USER messages'
  );
}

async function testRespond_controlThenLateJoinReceivesFirstAuthoredReply() {
  const fixture = await createFixture('respond-control-late-join-authored');
  const created = await createAttentionRequest(fixture);
  const late = await prisma.agent.create({
    data: { userId: fixture.ownerUserId, goal: 'Control-first late gate waiter', status: 'ACTIVE' },
  });
  trackedRealAgentIds.add(late.id);
  const send = (body: object) =>
    request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
      method: 'POST',
      headers: authHeaders(fixture.ownerToken),
      body: JSON.stringify(body),
    });
  const control = await send({ response: 'Approved' });
  assertStatus(control.status, 200, control.data);
  const joined = await appendGateWaiter(
    created.id,
    makeWorkflowId('control-first-late', late.id),
    late.id
  );
  assert(
    joined.pending === false && joined.response === 'Approved',
    'Late waiter must observe the accepted control'
  );
  const text = '  Read the existing order details before doing anything else.  ';
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await send({ response: 'Approved', user_message: text });
    assertStatus(reply.status, 200, reply.data);
  }
  const rows = await prisma.message.findMany({
    where: {
      agentId: late.id,
      role: 'USER',
      metadata: { path: ['attentionRequestId'], equals: created.id },
    },
  });
  assert(
    rows.length === 1 && rows[0].text === text,
    'Control-first late waiter lost or duplicated the first authored input'
  );
}

async function testRespond_authoredFallbackReadsWaitersAfterAcquiringRowLock() {
  const fixture = await createFixture('respond-locked-late-join');
  const created = await createAttentionRequest(fixture);
  const late = await prisma.agent.create({
    data: { userId: fixture.ownerUserId, goal: 'Concurrent late gate waiter', status: 'ACTIVE' },
  });
  trackedRealAgentIds.add(late.id);
  const send = (body: object) =>
    request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
      method: 'POST',
      headers: authHeaders(fixture.ownerToken),
      body: JSON.stringify(body),
    });
  const control = await send({ response: 'Approved' });
  assertStatus(control.status, 200, control.data);
  let release!: () => void;
  let announce!: (pid: number) => void;
  let rejectLock!: (error: unknown) => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<number>((resolve, reject) => {
    announce = resolve;
    rejectLock = reject;
  });
  // Reproduce a late append holding the attention lock before registering itself.
  const joining = prisma.$transaction(
    async (tx) => {
      const [session] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM "AgentAttentionRequest" WHERE id = ${created.id} FOR UPDATE`;
      announce(session.pid);
      await released;
      await tx.agentAttentionRequest.update({
        where: { id: created.id },
        data: {
          metadata: {
            gateWaiters: [{ workflowId: makeWorkflowId('locked-late', late.id), agentId: late.id }],
          },
        },
      });
    },
    { timeout: 15_000 }
  );
  void joining.catch(rejectLock);
  const pid = await locked;
  const text = '  Preserve the current order and report its details.  ';
  const replying = send({ response: 'Approved', user_message: text });
  try {
    let blocked = false;
    const deadline = Date.now() + 10_000;
    while (!blocked && Date.now() < deadline) {
      const [result] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
      blocked = result.blocked;
      if (!blocked) await sleep(10);
    }
    assert(blocked, 'Authored fallback never reached the concurrent attention row lock');
  } finally {
    release();
    await joining;
  }
  const result = await replying;
  assertStatus(result.status, 200, result.data);
  const rows = await prisma.message.findMany({
    where: {
      agentId: late.id,
      role: 'USER',
      metadata: { path: ['attentionRequestId'], equals: created.id },
    },
  });
  assert(
    rows.length === 1 && rows[0].text === text,
    'Authored fallback used waiter metadata read before its row lock'
  );
}

async function testRespond_authoredMessageFailureLeavesGatePending() {
  const fixture = await createFixture('respond-authored-missing-agent');
  const created = await createAttentionRequest(fixture, { agentId: fixture.missingAgentId });
  const result = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({
      response: 'Return only venue_prices',
      user_message: 'Return only venue_prices',
    }),
  });
  assertStatus(result.status, 403, result.data);
  const row = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    row.userResponse === null,
    'Failed authored-message persistence must roll back gate resolution'
  );
}

async function testRespond_authoredReplyFansOutOnceAndReachesLateWaiters() {
  const fixture = await createFixture('respond-authored-fanout');
  const waiter = await prisma.agent.create({
    data: { userId: fixture.ownerUserId, goal: 'Authored gate waiter', status: 'ACTIVE' },
  });
  const lateWaiter = await prisma.agent.create({
    data: { userId: fixture.ownerUserId, goal: 'Late authored gate waiter', status: 'ACTIVE' },
  });
  for (const agent of [waiter, lateWaiter]) trackedRealAgentIds.add(agent.id);
  const gateKey = `authored:${RUN_ID}:${randomUUID()}`;
  const created = await createAttentionRequest(fixture, {
    metadata: {
      gateWaiters: [
        {
          agentId: fixture.realAgentId,
          workflowId: makeWorkflowId('same-agent-waiter', fixture.realAgentId),
        },
        { agentId: waiter.id, workflowId: makeWorkflowId('first-waiter', waiter.id) },
        { agentId: waiter.id, workflowId: makeWorkflowId('duplicate-agent-waiter', waiter.id) },
      ],
    },
  });
  await prisma.agentAttentionRequest.update({ where: { id: created.id }, data: { gateKey } });
  // Capture the pending lookup, then let resolution win before append takes its row lock.
  const pending = await findPendingByGateKey(fixture.ownerUserId, gateKey);
  assert(pending?.id === created.id, 'Late join must start from a pending gate lookup');
  const text = '  Approved\nKeep these authored bytes.  ';
  const result = await request(`${BASE_URL}/api/attention-requests/${created.id}/respond`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ response: 'RESOLVED', user_message: text }),
  });
  assertStatus(result.status, 200, result.data);
  for (const agentId of [fixture.realAgentId, waiter.id]) {
    const rows = await prisma.message.findMany({
      where: {
        agentId,
        role: 'USER',
        metadata: { path: ['attentionRequestId'], equals: created.id },
      },
    });
    assert(
      rows.length === 1 && rows[0].text === text,
      'Each notified agent must receive one exact authored USER row'
    );
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const joined = await appendGateWaiter(
      pending.id,
      makeWorkflowId('late-waiter', lateWaiter.id),
      lateWaiter.id
    );
    assert(
      joined.pending === false && joined.response === 'RESOLVED',
      'Late waiter must retain the protocol response'
    );
    assert(
      joined.userMessage === text,
      'Late waiter signal must carry the same authored provenance'
    );
    const rows = await prisma.message.findMany({ where: { agentId: lateWaiter.id, role: 'USER' } });
    assert(
      rows.length === 1 && rows[0].text === text,
      'Late join must commit authored input once before returning for signal'
    );
  }
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

async function testRespond_repeatPreservesFirstTerminalResponse() {
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
    requestAfter.userResponse === 'first response',
    'Repeated respond should preserve the first terminal response'
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
  const approvalMessageId = await createPendingApprovalMessage(fixture.realAgentId, created.id);

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
  await expectApprovalMessageFinished(approvalMessageId);
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
  await expectLatestMessage(fixture.realAgentId, '  Do not proceed with this  ');
  const retry = await request(`${BASE_URL}/api/attention-requests/${created.id}/reject`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ message: '  Do not proceed with this  ' }),
  });
  assertStatus(retry.status, 200, retry.data);
  assert(
    (await countAgentMessages(fixture.realAgentId)) === afterMessages,
    'Repeated rejection must not duplicate authored input'
  );

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

  // Missing-agent rows are hidden from list/count (same as archived agents) so
  // the inbox never prompts for a run the user cannot open. Creating one must
  // not bump the unanswered badge.
  assert(
    (await getCount(fixture.ownerToken)) === countBefore,
    'Unanswered count must ignore attention rows whose agent does not exist'
  );

  const res = await request(`${BASE_URL}/api/attention-requests/${created.id}/reject`, {
    method: 'POST',
    headers: authHeaders(fixture.ownerToken),
    body: JSON.stringify({ message: 'This will fail because the agent is missing' }),
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:id/reject (403 unowned missing agent)');

  const requestAfter = await getRequestById(created.id, authHeaders(fixture.ownerToken));
  assert(
    requestAfter.userResponse === null,
    'Failed rejection should leave the request unanswered'
  );

  const row = await withTransientDbRetry('reject-missing-agent-row', async () => {
    return prisma.agentAttentionRequest.findUnique({ where: { id: created.id } });
  });
  assert(row?.userResponse === null, 'Failed rejection must leave the DB row pending');
  assert(
    (await getCount(fixture.ownerToken)) === countBefore,
    'Failed rejection must not surface a missing-agent request in the inbox count'
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
        {
          name: 'worker and external callers retain legitimate current stale and native workflow bindings',
          fn: testCreate_preservesLegitimateWorkerAndExternalWorkflowBindings,
        },
        {
          name: 'own agent cannot target a foreign primary workflow',
          fn: () => testCreate_ownedAgentCannotTargetForeignWorkflow(false),
        },
        {
          name: 'own agent cannot pair a foreign waiter workflow with its own agent ID',
          fn: () => testCreate_ownedAgentCannotTargetForeignWorkflow(true),
        },
        {
          name: 'own JWT cannot create an attention reply targeting a foreign agent',
          fn: testCreate_externalCallerCannotWriteAuthoredInputToForeignAgent,
        },
        { name: 'create requires authentication', fn: testCreate_requiresAuthentication },
        { name: 'happy path + round-trip', fn: testCreate_happyRoundTrip },
        { name: 'missing question', fn: testCreate_missingQuestion },
        { name: 'empty body', fn: testCreate_emptyBody },
        { name: 'empty question string', fn: testCreate_emptyQuestion },
        { name: 'invalid imageUrl', fn: testCreate_invalidImageUrl },
        {
          name: 'parallel create persists both requests',
          fn: testCreate_parallelCreatesPersistBoth,
        },
        {
          name: 'gate dedup collapses to one pending request',
          fn: testCreate_gateDedupCollapsesToOnePendingRequest,
        },
        {
          name: 'gate resolve signals all waiters (fan-in)',
          fn: testCreate_gateResolveSignalsAllWaiters,
        },
        {
          name: 'gate renders one minimal SMS action',
          fn: testCreate_gateSmsRendersOneMinimalAction,
        },
      ],
    },
    {
      name: 'GET / (list)',
      tests: [
        { name: 'owner isolation + oldest-first ordering', fn: testList_happyIsolationAndOrdering },
        {
          name: 'excludes requests for archived agents',
          fn: testList_excludesArchivedAgentRequests,
        },
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
        ...(['gate', 'approval'] as const).flatMap((producer) =>
          (['owned', 'foreign', 'missing-key'] as const).map((caller) => ({
            name: `actual ${producer} worker create preserves ${caller} authority`,
            fn: () => testCreate_actualWorkerProducerAuthenticates(producer, caller),
          }))
        ),
        {
          name: 'legacy foreign auth completion is forbidden atomically',
          fn: () => testAuthCompletion_legacyForeignAgentIsForbiddenAtomically(),
        },
        {
          name: 'legacy auth child cannot complete a different users parent request',
          fn: () => testAuthCompletion_legacyForeignAgentIsForbiddenAtomically(true),
        },
        {
          name: 'legacy foreign primary rejects authored writes atomically',
          fn: () => testRespond_legacyForeignPrimaryAndWaiterCannotReceiveAuthoredInput(true),
        },
        {
          name: 'legacy foreign waiter rejects authored writes atomically',
          fn: () => testRespond_legacyForeignPrimaryAndWaiterCannotReceiveAuthoredInput(false),
        },
        {
          name: 'control-first authored input persists once and later conflict is explicit',
          fn: testRespond_authoredInputAfterControlIsPreservedAndConflictsAreExplicit,
        },
        {
          name: 'authored replies reach immediate and late waiters exactly once',
          fn: testRespond_authoredReplyFansOutOnceAndReachesLateWaiters,
        },
        {
          name: 'control-first late waiter receives the first authored reply once',
          fn: testRespond_controlThenLateJoinReceivesFirstAuthoredReply,
        },
        {
          name: 'authored fallback reads waiter metadata after acquiring its row lock',
          fn: testRespond_authoredFallbackReadsWaitersAfterAcquiringRowLock,
        },
        {
          name: 'authored input persists once with original bytes',
          fn: testRespond_authoredMessagePersistsExactlyOnceWithOriginalBytes,
        },
        {
          name: 'controls and completion narratives do not become USER input',
          fn: testRespond_controlsAndNarrativesDoNotBecomeUserMessages,
        },
        {
          name: 'authored input failure rolls back gate resolution',
          fn: testRespond_authoredMessageFailureLeavesGatePending,
        },
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
          name: 'repeat respond preserves first terminal response',
          fn: testRespond_repeatPreservesFirstTerminalResponse,
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
          name: 'with message preserves authored bytes once',
          fn: testReject_withMessageCreatesTrimmedUserMessage,
        },
        {
          name: 'blank message creates no side effect',
          fn: testReject_blankMessageDoesNotCreateSideEffect,
        },
        {
          name: 'unowned missing agent + message returns 403 and keeps request pending',
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
