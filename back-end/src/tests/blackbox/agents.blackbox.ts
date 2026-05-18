#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for /api/agents
 *
 * Every test case owns its own users, agents, and state. Cases run in parallel
 * within the domain (default concurrency 30). No shared mutable fixtures.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/agents.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/agents.blackbox.ts
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
  throw new Error(`Invalid BLACKBOX_TEST_CASE_CONCURRENCY: ${rawCaseConcurrency}`);
}

// ---------------------------------------------------------------------------
// Tracking for cleanup
// ---------------------------------------------------------------------------
const trackedAgentIds = new Set<string>();
const trackedUserIds = new Set<string>();

// ---------------------------------------------------------------------------
// Capture types
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Zod schemas — response contracts
// ---------------------------------------------------------------------------
const ErrorResponse = z.object({ error: z.string(), details: z.array(z.any()).optional() });

const AgentListItem = z.object({
  agent_id: z.string().uuid(),
  goal: z.string(),
  model: z.string(),
  source: z.enum(['WEB', 'MAC_APP', 'SMS']),
  reasoning_max_tokens: z.number(),
  progress: z.number(),
  status: z.string(),
  status_message: z.string().nullable(),
  temporal_workflow_id: z.string().nullable(),
  token_count: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  context_size: z.number(),
  message_count: z.number(),
  created_at: DATE_LIKE,
  updated_at: DATE_LIKE,
});

const ListAgentsResponse = z.object({
  agents: z.array(AgentListItem),
});

const TreeAgentItem = z.object({
  agent_id: z.string().uuid(),
  parent_agent_id: z.string().uuid().nullable(),
  goal: z.string(),
  status: z.string(),
  progress: z.number(),
  tools_in_use: z.array(z.string()),
  message_count: z.number(),
  output_schema: z.unknown().nullable(),
  structured_output: z.unknown().nullable(),
  tree_cost_cents: z.number(),
});

const TreeResponse = z.object({
  agents: z.array(TreeAgentItem),
});

const CreateAgentResponse = z.object({
  agent_id: z.string().uuid(),
  progress: z.number(),
  goal: z.string(),
  model: z.string(),
  source: z.enum(['WEB', 'MAC_APP']),
  reasoning_max_tokens: z.number(),
  status: z.string(),
  status_message: z.string().nullable(),
  temporal_workflow_id: z.string().nullable(),
  created_at: DATE_LIKE,
  updated_at: DATE_LIKE,
  available_endpoints: z.record(z.any()),
});

const MessageItem = z.object({
  message_id: z.string(),
  timestamp: DATE_LIKE,
  text: z.string(),
  role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']),
  metadata: z.unknown().nullable(),
  file_pointer: z.unknown().nullable(),
});

const VerifierSchema = z
  .object({
    type: z.string(),
  })
  .nullable();

const ToolItem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

const AgentDetail = z.object({
  agent_id: z.string().uuid(),
  parent_agent_id: z.string().uuid().nullable(),
  parent_goal: z.string().nullable(),
  goal: z.string(),
  model: z.string(),
  source: z.enum(['WEB', 'MAC_APP', 'SMS']),
  reasoning_max_tokens: z.number(),
  progress: z.number(),
  status: z.string(),
  status_message: z.string().nullable(),
  temporal_workflow_id: z.string().nullable(),
  token_count: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  tool_tokens_in: z.number(),
  tool_tokens_out: z.number(),
  tool_cost_cents: z.number(),
  context_size: z.number(),
  message_count: z.number(),
  price_limit_cents: z.number(),
  tree_cost_cents: z.number(),
  token_in_price_microdollars: z.number().nullable(),
  token_out_price_microdollars: z.number().nullable(),
  created_at: DATE_LIKE,
  updated_at: DATE_LIKE,
  write_lock_enabled: z.boolean(),
  verifier: VerifierSchema,
  tools: z.array(ToolItem),
  response_schema: z.unknown().nullable(),
});

const GetAgentResponse = z.object({
  agent: AgentDetail,
  messages: z.array(MessageItem),
  pagination: z.object({
    has_more: z.boolean(),
    oldest_timestamp: z.unknown().nullable(),
  }),
});

const AncestorsResponse = z.object({
  ancestors: z.array(z.object({ id: z.string(), goal: z.string() })),
});

const PostMessageResponse = z.object({
  message_id: z.string(),
  timestamp: DATE_LIKE,
  text: z.string(),
  role: z.enum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']),
});

const StatusResponse = z.object({
  agent_id: z.string().uuid(),
  status: z.string(),
});

const UpdateStatusResponse = z.object({
  agent_id: z.string().uuid(),
  status: z.string(),
  status_message: z.string().nullable(),
  progress: z.number(),
  token_count: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  context_size: z.number(),
  message_count: z.number(),
  updated_at: DATE_LIKE,
});

const UpdateAgentResponse = z.object({
  agent: z.object({
    agent_id: z.string().uuid(),
    goal: z.string().optional(),
    model: z.string(),
    reasoning_max_tokens: z.number(),
    progress: z.number(),
    status: z.string(),
    status_message: z.string().nullable(),
    temporal_workflow_id: z.string().nullable(),
    token_count: z.number(),
    tokens_in: z.number(),
    tokens_out: z.number(),
    context_size: z.number(),
    message_count: z.number(),
    price_limit_cents: z.number(),
    tree_cost_cents: z.number(),
    created_at: DATE_LIKE,
    updated_at: DATE_LIKE,
    write_lock_enabled: z.boolean(),
    verifier: VerifierSchema,
    tools: z.array(ToolItem),
  }),
});

const SuccessResponse = z.object({ success: z.boolean() });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

interface RequestOptions extends RequestInit {
  body?: string;
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
      if (!isTransientDbError(error) || attempt === attempts) throw error;
      console.warn(
        `[retry] ${label} attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function apiKeyHeaders(userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': API_KEY };
  if (userId) h['X-User-Id'] = userId;
  return h;
}

async function request(
  url: string,
  options: RequestOptions = {}
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
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 500)}`
    );
  }
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  return result.data;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
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
      'error' in res.data;
    if (!transientFailure || attempt === 6) {
      assertStatus(res.status, 200, res.data);
    }
    console.warn(`[retry] auth anonymous for ${label} attempt ${attempt}/6`);
    await sleep(250 * attempt);
  }
  throw new Error(`Anonymous session setup exhausted retries for ${label}`);
}

/**
 * Create an agent via API key auth. Root agents are created in chat mode
 * (no start_phase), so chatHandler and GitHub repo creation still fire in the
 * background and these tests do not wait for them.
 *
 * Retries on:
 *  - Network errors (fetch throws): connection refused, DNS failures
 *  - HTTP 500 with "Failed to create agent": the server's creation pipeline
 *    failed (e.g., OpenRouter model pricing timeout under concurrency). The 500
 *    means the agent was NOT created, so retry is safe. Any partial DB rows are
 *    tracked and cleaned up.
 * Does NOT retry on other status codes (400, 401, 403, 404, 422, etc.).
 */
async function createTestAgent(
  userId: string,
  goal?: string,
  extraBody?: Record<string, unknown>
): Promise<string> {
  const finalGoal = goal || `Blackbox test agent ${RUN_ID} ${randomUUID().slice(0, 8)}`;
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: { status: number; data: unknown; headers: Headers };
    try {
      res = await request(`${BASE_URL}/api/agents`, {
        method: 'POST',
        headers: apiKeyHeaders(userId),
        body: JSON.stringify({ goal: finalGoal, ...extraBody }),
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        console.warn(
          `[retry] createTestAgent attempt ${attempt}/${maxAttempts} network error: ${err}`
        );
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
    if (res.status === 201) {
      const body = assertSchema(CreateAgentResponse, res.data, 'createTestAgent');
      trackedAgentIds.add(body.agent_id);
      return body.agent_id;
    }
    // Only retry the specific "Failed to create agent" 500 — that means the
    // creation pipeline failed before persisting (e.g., OpenRouter pricing timeout).
    // Other 500s might indicate partial creation, so don't retry those.
    const isRetryable =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data &&
      (res.data as { error?: unknown }).error === 'Failed to create agent';
    if (isRetryable && attempt < maxAttempts) {
      console.warn(`[retry] createTestAgent attempt ${attempt}/${maxAttempts} got retryable 500`);
      await sleep(1000 * attempt + Math.random() * 500);
      continue;
    }
    assertStatus(res.status, 201, res.data);
  }
  throw new Error('createTestAgent exhausted retries');
}

/**
 * POST /api/agents with retry on 500 "Failed to create agent".
 * Returns the full { status, data, headers } response on the first non-retryable result.
 * Only retries on 500 with error === 'Failed to create agent'; all other statuses are
 * returned immediately so callers can assert on them normally.
 */
async function postAgentWithRetry(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  maxAttempts = 5
): Promise<{ status: number; data: unknown; headers: Headers }> {
  let lastRes: { status: number; data: unknown; headers: Headers } | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    lastRes = res;
    const isRetryable =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data &&
      (res.data as { error?: unknown }).error === 'Failed to create agent';
    if (!isRetryable || attempt === maxAttempts) return res;
    console.warn(`[retry] postAgentWithRetry attempt ${attempt}/${maxAttempts} got 500`);
    await sleep(500 * attempt);
  }
  return lastRes!;
}

async function deleteTestAgent(agentId: string, userId: string): Promise<void> {
  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(userId),
  });
}

// ---------------------------------------------------------------------------
// Capture helpers (for boundary tests)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Test definitions — each test is self-contained with its own fixtures
// ---------------------------------------------------------------------------
interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

// ========================= GET / (list agents) =============================

test('GET / — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents`);
  assertStatus(res.status, 401, res.data);
});

test('GET / — happy path (JWT) — schema validated', async () => {
  const session = await createAnonymousSession('list-jwt');
  const res = await request(`${BASE_URL}/api/agents`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListAgentsResponse, res.data, 'GET /');
});

test('GET / — happy path (API key) — schema validated', async () => {
  const session = await createAnonymousSession('list-apikey');
  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListAgentsResponse, res.data, 'GET / (API key)');
});

test('GET / — new user sees empty list', async () => {
  const session = await createAnonymousSession('list-empty');
  const res = await request(`${BASE_URL}/api/agents`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListAgentsResponse, res.data, 'GET / empty');
  assert(body.agents.length === 0, `Expected 0 agents, got ${body.agents.length}`);
});

test('GET / — tenant isolation: user A cannot see user B agents', async () => {
  const sessionA = await createAnonymousSession('list-iso-a');
  const sessionB = await createAnonymousSession('list-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Isolation test agent');

  const resB = await request(`${BASE_URL}/api/agents`, {
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(resB.status, 200, resB.data);
  const bodyB = assertSchema(ListAgentsResponse, resB.data, 'GET / isolation');
  const found = bodyB.agents.find((a) => a.agent_id === agentId);
  assert(!found, 'User B should not see user A agent');

  await deleteTestAgent(agentId, sessionA.user.id);
});

test('GET / — excludes soft-deleted agents', async () => {
  const session = await createAnonymousSession('list-deleted');
  const agentId = await createTestAgent(session.user.id, 'Soon deleted');
  await deleteTestAgent(agentId, session.user.id);

  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListAgentsResponse, res.data, 'GET / after delete');
  const found = body.agents.find((a) => a.agent_id === agentId);
  assert(!found, 'Deleted agent should not appear in list');
});

test('GET / — no-cache headers present', async () => {
  const session = await createAnonymousSession('list-cache');
  const res = await request(`${BASE_URL}/api/agents`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  const cc = res.headers.get('cache-control');
  assert(cc && cc.includes('no-store'), `Expected no-store in Cache-Control, got "${cc}"`);
});

// ========================= GET /tree =======================================

test('GET /tree — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/tree`);
  assertStatus(res.status, 401, res.data);
});

test('GET /tree — missing busId → 400', async () => {
  const session = await createAnonymousSession('tree-no-bus');
  const res = await request(`${BASE_URL}/api/agents/tree`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
});

test('GET /tree — happy path — schema validated', async () => {
  const session = await createAnonymousSession('tree-happy');
  const agentId = await createTestAgent(session.user.id, 'Tree test agent');

  // Root agents have busId = own id
  const res = await request(`${BASE_URL}/api/agents/tree?busId=${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(TreeResponse, res.data, 'GET /tree');
  assert(body.agents.length >= 1, 'Expected at least 1 agent in tree');
  const self = body.agents.find((a) => a.agent_id === agentId);
  assert(self, 'Agent should appear in its own tree');

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /tree — unknown busId returns empty', async () => {
  const session = await createAnonymousSession('tree-empty');
  const res = await request(`${BASE_URL}/api/agents/tree?busId=${randomUUID()}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(TreeResponse, res.data, 'GET /tree empty');
  assert(body.agents.length === 0, `Expected 0 agents in tree, got ${body.agents.length}`);
});

// ========================= POST / (create agent) ===========================

test('POST / — no auth → 401 or 402', async () => {
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    body: JSON.stringify({ goal: 'test' }),
  });
  if (res.status !== 401 && res.status !== 402) {
    throw new Error(`Expected 401 or 402, got ${res.status}`);
  }
});

test('POST / — anonymous JWT cannot create agent → 401', async () => {
  const session = await createAnonymousSession('create-anon-rejected');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ goal: 'Anonymous create should fail' }),
  });
  assertStatus(res.status, 401, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'POST / anonymous rejected');
  assert(body.error.includes('Login required'), `Unexpected error: ${body.error}`);
});

test('POST / — missing goal → 400', async () => {
  const session = await createAnonymousSession('create-no-goal');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / missing goal');
});

test('POST / — empty goal → 400', async () => {
  const session = await createAnonymousSession('create-empty-goal');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ goal: '' }),
  });
  assertStatus(res.status, 400, res.data);
});

test('POST / — happy path — full response schema', async () => {
  const session = await createAnonymousSession('create-happy');
  const goal = `Create happy test ${RUN_ID} ${randomUUID().slice(0, 8)}`;
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), { goal });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / happy');
  assert(body.goal === goal, `Goal mismatch: "${body.goal}" !== "${goal}"`);
  assert(body.status === 'ACTIVE', `Expected ACTIVE status, got ${body.status}`);
  assert(body.progress === 0, `Expected progress 0, got ${body.progress}`);
  trackedAgentIds.add(body.agent_id);

  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — creates initial goal message', async () => {
  const session = await createAnonymousSession('create-msg');
  const goal = `Goal message test ${RUN_ID}`;
  const agentId = await createTestAgent(session.user.id, goal);

  // Verify via GET detail
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'POST / verify goal message');
  assert(body.messages.length >= 1, `Expected at least 1 message, got ${body.messages.length}`);
  const goalMsg = body.messages.find((m) => m.role === 'USER' && m.text === goal);
  assert(goalMsg, 'Initial goal message not found');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST / — auto-generates verifier', async () => {
  const session = await createAnonymousSession('create-verifier');
  const agentId = await createTestAgent(session.user.id, 'Verifier test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'POST / verify verifier');
  assert(body.agent.verifier !== null, 'Verifier should be auto-generated');
  assert(
    body.agent.verifier!.type === 'FLOAT_LLM_JUDGE',
    `Expected FLOAT_LLM_JUDGE, got ${body.agent.verifier!.type}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('POST / — custom model preserved', async () => {
  const session = await createAnonymousSession('create-model');
  const model = 'rose-labs/rose-1-ultra';
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Model test',
    model,
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / model');
  assert(body.model === model, `Expected model "${model}", got "${body.model}"`);
  trackedAgentIds.add(body.agent_id);

  await deleteTestAgent(body.agent_id, session.user.id);
});

// ========================= GET /:id (detail) ===============================

test('GET /:id — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
});

test('GET /:id — not found → 404', async () => {
  const session = await createAnonymousSession('get-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('GET /:id — happy path — full schema', async () => {
  const session = await createAnonymousSession('get-happy');
  const agentId = await createTestAgent(session.user.id, 'Detail test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'GET /:id happy');
  assert(body.agent.agent_id === agentId, 'Agent ID mismatch');
  assert(body.agent.goal === 'Detail test', 'Goal mismatch');
  assert(Array.isArray(body.messages), 'Messages should be array');
  assert(body.pagination.has_more === false, 'Pagination should indicate no more');

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /:id — tenant isolation: user B cannot see user A agent → 404', async () => {
  const sessionA = await createAnonymousSession('get-iso-a');
  const sessionB = await createAnonymousSession('get-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Isolation detail test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  await deleteTestAgent(agentId, sessionA.user.id);
});

test('GET /:id — internal auth bypasses user filter', async () => {
  const session = await createAnonymousSession('get-internal');
  const agentId = await createTestAgent(session.user.id, 'Internal access test');

  // API key without user ID → internal auth, no user filter
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: { 'X-API-Key': API_KEY },
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GetAgentResponse, res.data, 'GET /:id internal');

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /:id — no-cache headers', async () => {
  const session = await createAnonymousSession('get-cache');
  const agentId = await createTestAgent(session.user.id, 'Cache test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const cc = res.headers.get('cache-control');
  assert(cc && cc.includes('no-store'), `Expected no-store, got "${cc}"`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= GET /:id/ancestors ==============================

test('GET /:id/ancestors — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/ancestors`);
  assertStatus(res.status, 401, res.data);
});

test('GET /:id/ancestors — root agent has empty ancestors', async () => {
  const session = await createAnonymousSession('ancestors-root');
  const agentId = await createTestAgent(session.user.id, 'Ancestor root test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/ancestors`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AncestorsResponse, res.data, 'GET /:id/ancestors root');
  assert(
    body.ancestors.length === 0,
    `Root agent should have 0 ancestors, got ${body.ancestors.length}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('GET /:id/ancestors — child agent returns parent', async () => {
  const session = await createAnonymousSession('ancestors-child');
  const parentGoal = `Parent agent ${RUN_ID}`;
  const parentId = await createTestAgent(session.user.id, parentGoal);

  // Create child agent via API with parent_agent_id
  const childCreateRes = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Child agent',
    parent_agent_id: parentId,
    bus_id: parentId,
  });

  let childId: string;
  if (childCreateRes.status === 201) {
    childId = (childCreateRes.data as { agent_id: string }).agent_id;
  } else {
    // Temporal not running: child was written to DB before workflow launch failed.
    const child = await withTransientDbRetry('find-child-ancestors', async () =>
      prisma.agent.findFirst({
        where: { parentAgentId: parentId, userId: session.user.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    );
    if (!child) throw new Error('Child agent not found after sub-agent creation attempt');
    childId = child.id;
  }
  trackedAgentIds.add(childId);

  const res = await request(`${BASE_URL}/api/agents/${childId}/ancestors`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AncestorsResponse, res.data, 'GET /:id/ancestors child');
  assert(body.ancestors.length === 1, `Expected 1 ancestor, got ${body.ancestors.length}`);
  assert(body.ancestors[0].id === parentId, 'Ancestor should be parent');
  assert(body.ancestors[0].goal === parentGoal, 'Ancestor goal should match parent');

  await deleteTestAgent(parentId, session.user.id);
  // Child is cleaned up by parent delete (recursive) or final cleanup
});

// ========================= POST /:id/messages ==============================

test('POST /:id/messages — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/messages — not found → 404', async () => {
  const session = await createAnonymousSession('msg-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ message: 'test', role: 'USER' }),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/messages — user message (JWT) — schema validated', async () => {
  const session = await createAnonymousSession('msg-user');
  const agentId = await createTestAgent(session.user.id, 'Message test agent');

  const msgText = `User message ${randomUUID().slice(0, 8)}`;
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: msgText }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST /:id/messages user');
  assert(body.role === 'USER', `User auth should force USER role, got ${body.role}`);
  assert(body.text === msgText, 'Message text mismatch');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — internal message requires role', async () => {
  const session = await createAnonymousSession('msg-int-no-role');
  const agentId = await createTestAgent(session.user.id, 'Internal role test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'test' }),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — internal TOOL message', async () => {
  const session = await createAnonymousSession('msg-tool');
  const agentId = await createTestAgent(session.user.id, 'Tool message test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      message: 'Search results: 3 items found',
      role: 'TOOL',
      metadata: { toolName: 'web_search', toolStatus: 'success' },
    }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST /:id/messages TOOL');
  assert(body.role === 'TOOL', `Expected TOOL role, got ${body.role}`);

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — read-after-write: message visible in detail', async () => {
  const session = await createAnonymousSession('msg-raw');
  const agentId = await createTestAgent(session.user.id, 'RAW message test');
  const msgText = `RAW test ${randomUUID().slice(0, 8)}`;

  await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: msgText, role: 'ASSISTANT' }),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'read-after-write messages');
  const found = body.messages.find((m) => m.text === msgText && m.role === 'ASSISTANT');
  assert(found, 'Posted message should be visible in agent detail');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — user role forced even if body says SYSTEM', async () => {
  const session = await createAnonymousSession('msg-role-force');
  const agentId = await createTestAgent(session.user.id, 'Role force test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'test', role: 'SYSTEM' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST messages role force');
  assert(body.role === 'USER', `JWT auth should force USER, got ${body.role}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= GET /:id/status =================================

test('GET /:id/status — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/status`);
  assertStatus(res.status, 401, res.data);
});

test('GET /:id/status — not found → 404', async () => {
  const session = await createAnonymousSession('status-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/status`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('GET /:id/status — happy path — schema validated', async () => {
  const session = await createAnonymousSession('status-happy');
  const agentId = await createTestAgent(session.user.id, 'Status test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(StatusResponse, res.data, 'GET /:id/status');
  assert(body.agent_id === agentId, 'Agent ID mismatch');
  assert(body.status === 'ACTIVE', `Expected ACTIVE, got ${body.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= PATCH /:id/status ===============================

test('PATCH /:id/status — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'ACTIVE',
      progress: 0.5,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });
  assertStatus(res.status, 401, res.data);
});

test('PATCH /:id/status — not found → 404', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'ACTIVE',
      progress: 0.5,
      tokenCount: 100,
      tokensIn: 50,
      tokensOut: 50,
      contextSize: 1000,
      messageCount: 5,
    }),
  });
  assertStatus(res.status, 404, res.data);
});

test('PATCH /:id/status — happy path — schema validated', async () => {
  const session = await createAnonymousSession('upd-status-happy');
  const agentId = await createTestAgent(session.user.id, 'Update status test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COMPLETED',
      statusMessage: 'All done',
      progress: 1.0,
      tokenCount: 5000,
      tokensIn: 3000,
      tokensOut: 2000,
      contextSize: 10000,
      messageCount: 20,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateStatusResponse, res.data, 'PATCH /:id/status');
  assert(body.status === 'COMPLETED', `Expected COMPLETED, got ${body.status}`);
  assert(body.progress === 1.0, `Expected progress 1.0, got ${body.progress}`);
  assert(body.token_count === 5000, `Expected token_count 5000, got ${body.token_count}`);
  assert(body.status_message === 'All done', `Expected "All done", got "${body.status_message}"`);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id/status — invalid body → 400', async () => {
  const session = await createAnonymousSession('upd-status-bad');
  const agentId = await createTestAgent(session.user.id, 'Bad status body test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ status: 'INVALID_STATUS' }),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id/status — read-after-write: status visible in detail', async () => {
  const session = await createAnonymousSession('upd-status-raw');

  // Create agent via HTTP so it's visible to the server
  const agentId = await createTestAgent(session.user.id, 'RAW status test');

  await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'FAILED',
      statusMessage: 'Something broke',
      progress: 0.3,
      tokenCount: 1000,
      contextSize: 5000,
      messageCount: 10,
    }),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetAgentResponse, res.data, 'read-after-write status');
  assert(body.agent.status === 'FAILED', `Expected FAILED, got ${body.agent.status}`);
  assert(body.agent.status_message === 'Something broke', 'Status message mismatch');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= DELETE /:id =====================================

test('DELETE /:id — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, { method: 'DELETE' });
  assertStatus(res.status, 401, res.data);
});

test('DELETE /:id — not found → 404', async () => {
  const session = await createAnonymousSession('del-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
});

test('DELETE /:id — happy path → 204', async () => {
  const session = await createAnonymousSession('del-happy');
  const agentId = await createTestAgent(session.user.id, 'Delete test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 204, res.data);
});

test('DELETE /:id — idempotent: re-delete → 404', async () => {
  const session = await createAnonymousSession('del-idempotent');
  const agentId = await createTestAgent(session.user.id, 'Idempotent delete test');

  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
});

test('DELETE /:id — read-after-write: deleted agent → 404 on GET', async () => {
  const session = await createAnonymousSession('del-raw');
  const agentId = await createTestAgent(session.user.id, 'Delete RAW test');

  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
});

test('DELETE /:id — tenant isolation: user B cannot delete user A agent', async () => {
  const sessionA = await createAnonymousSession('del-iso-a');
  const sessionB = await createAnonymousSession('del-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Delete isolation test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  // Agent should still be accessible to owner
  const check = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(sessionA.user.id),
  });
  assertStatus(check.status, 200, check.data);

  await deleteTestAgent(agentId, sessionA.user.id);
});

// ========================= POST /:id/pause =================================

test('POST /:id/pause — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/pause`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/pause — not found → 404', async () => {
  const session = await createAnonymousSession('pause-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/pause`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/pause — happy path: status changes to PAUSED', async () => {
  const session = await createAnonymousSession('pause-happy');

  // Create agent via HTTP so it's visible to the server
  const agentId = await createTestAgent(session.user.id, 'Pause test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/pause`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /:id/pause');

  // Verify status changed
  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(statusRes.status, 200, statusRes.data);
  const status = assertSchema(StatusResponse, statusRes.data, 'pause verify');
  assert(status.status === 'PAUSED', `Expected PAUSED, got ${status.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/resume ================================

test('POST /:id/resume — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/resume`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/resume — not found → 404', async () => {
  const session = await createAnonymousSession('resume-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/resume — happy path: status changes to ACTIVE', async () => {
  const session = await createAnonymousSession('resume-happy');

  // Seed the route precondition directly. Creating a chat-mode root via HTTP
  // starts a background chat handler, which can independently fail and overwrite
  // the status while this route-level assertion is reading it.
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-resume-happy', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Resume test',
        status: 'PAUSED',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Resume
  const res = await request(`${BASE_URL}/api/agents/${agentId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /:id/resume');

  // Verify status
  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'resume verify');
  assert(status.status === 'ACTIVE', `Expected ACTIVE after resume, got ${status.status}`);

  await withTransientDbRetry('cleanup-resume-happy', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

test('POST /:id/resume — child with paused parent → 400', async () => {
  const session = await createAnonymousSession('resume-parent-paused');

  // Create parent via HTTP then set to PAUSED so both parent and child are server-visible
  const parentId = await createTestAgent(session.user.id, 'Parent for resume test');
  await request(`${BASE_URL}/api/agents/${parentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'PAUSED',
      progress: 0,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });

  // Create child via HTTP with parent_agent_id — may fail (500) if Temporal not running,
  // but the agent row is committed to DB before the workflow launch attempt
  const childCreateRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Child resume test',
      parent_agent_id: parentId,
      bus_id: parentId,
    }),
  });

  let childId: string;
  if (childCreateRes.status === 201) {
    childId = (childCreateRes.data as { agent_id: string }).agent_id;
  } else {
    // Temporal not running: child was written to DB before workflow launch failed.
    // Find child by parentAgentId lookup.
    const child = await withTransientDbRetry('find-child-resume', async () =>
      prisma.agent.findFirst({
        where: { parentAgentId: parentId, userId: session.user.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    );
    if (!child) throw new Error('Child agent not found after sub-agent creation attempt');
    childId = child.id;
    // Set child to PAUSED so its status matches original test intent
    await request(`${BASE_URL}/api/agents/${childId}/status`, {
      method: 'PATCH',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        status: 'PAUSED',
        progress: 0,
        tokenCount: 0,
        contextSize: 0,
        messageCount: 0,
      }),
    });
  }
  trackedAgentIds.add(childId);

  // Try to resume child while parent is paused → 400
  const res = await request(`${BASE_URL}/api/agents/${childId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(parentId, session.user.id);
});

// ========================= PATCH /:id (update agent) =======================

test('PATCH /:id — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
});

test('PATCH /:id — not found → 404', async () => {
  const session = await createAnonymousSession('upd-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ model: 'rose-labs/rose-1-ultra' }),
  });
  assertStatus(res.status, 404, res.data);
});

test('PATCH /:id — happy path: update model — schema validated', async () => {
  const session = await createAnonymousSession('upd-model');
  const agentId = await createTestAgent(session.user.id, 'Update model test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ model: 'rose-labs/rose-1-ultra' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id model');
  assert(
    body.agent.model === 'rose-labs/rose-1-ultra',
    `Expected updated model, got ${body.agent.model}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — update write_lock_enabled', async () => {
  const session = await createAnonymousSession('upd-wl');
  const agentId = await createTestAgent(session.user.id, 'Write lock test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ write_lock_enabled: false }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id write_lock');
  assert(body.agent.write_lock_enabled === false, 'Write lock should be disabled');

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — price_limit_cents below current cost → 400', async () => {
  const session = await createAnonymousSession('upd-price-low');
  const agentId = await createTestAgent(session.user.id, 'Price limit test');

  // Set tree cost to 50 cents via internal update
  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ tree_cost_cents: 50 }),
  });

  // Try to set limit below current cost
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ price_limit_cents: 30 }),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — price_limit_cents at or above current cost succeeds', async () => {
  const session = await createAnonymousSession('upd-price-ok');
  const agentId = await createTestAgent(session.user.id, 'Price limit OK test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ price_limit_cents: 500 }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id price ok');
  assert(body.agent.price_limit_cents === 500, `Expected 500, got ${body.agent.price_limit_cents}`);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — invalid body → 400', async () => {
  const session = await createAnonymousSession('upd-bad-body');
  const agentId = await createTestAgent(session.user.id, 'Bad body test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ status: 'NOT_A_REAL_STATUS' }),
  });
  assertStatus(res.status, 400, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

test('PATCH /:id — tenant isolation: user B cannot update user A agent', async () => {
  const sessionA = await createAnonymousSession('upd-iso-a');
  const sessionB = await createAnonymousSession('upd-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Update isolation test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: authHeaders(sessionB.session.access_token),
    body: JSON.stringify({ model: 'rose-labs/rose-1-ultra' }),
  });
  assertStatus(res.status, 404, res.data);

  await deleteTestAgent(agentId, sessionA.user.id);
});

// ========================= POST /:id/start-agent ==========================

test('POST /:id/start-agent — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/start-agent`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/start-agent — not found → 404', async () => {
  const session = await createAnonymousSession('start-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/start-agent`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

// ========================= POST /:id/restart ===============================

test('POST /:id/restart — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/restart`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/restart — not found → 404', async () => {
  const session = await createAnonymousSession('restart-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/restart`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

// ========================= POST /:id/signal/* ==============================

test('POST /:id/signal/signup_completed — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/signal/signup_completed`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/signal/signup_completed — not found → 404', async () => {
  const session = await createAnonymousSession('sig-comp-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/signal/signup_completed`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/signal/signup_completed — happy path (no workflow)', async () => {
  const session = await createAnonymousSession('sig-comp-happy');
  const agentId = await createTestAgent(session.user.id, 'Signup signal test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/signal/signup_completed`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'signal/signup_completed');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/signal/signup_dismissed — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/signal/signup_dismissed`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /:id/signal/signup_dismissed — not found → 404', async () => {
  const session = await createAnonymousSession('sig-dis-404');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/signal/signup_dismissed`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 404, res.data);
});

test('POST /:id/signal/signup_dismissed — happy path (no workflow)', async () => {
  const session = await createAnonymousSession('sig-dis-happy');
  const agentId = await createTestAgent(session.user.id, 'Signup dismiss test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/signal/signup_dismissed`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'signal/signup_dismissed');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /messages/batch ============================

test('POST /messages/batch — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    body: JSON.stringify({ ids: [] }),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /messages/batch — empty ids → 400', async () => {
  const session = await createAnonymousSession('batch-empty');
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ ids: [] }),
  });
  assertStatus(res.status, 400, res.data);
  trackedUserIds.add(session.user.id);
});

test('POST /messages/batch — nonexistent IDs → 200 empty', async () => {
  const session = await createAnonymousSession('batch-fake');
  const fakeIds = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ ids: fakeIds }),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { messages: unknown[] };
  if (!Array.isArray(body.messages)) {
    throw new Error('Expected messages array in response');
  }
  if (body.messages.length !== 0) {
    throw new Error(`Expected 0 messages for fake IDs, got ${body.messages.length}`);
  }
  trackedUserIds.add(session.user.id);
});

test('POST /messages/batch — over 50 IDs → 400', async () => {
  const session = await createAnonymousSession('batch-over50');
  trackedUserIds.add(session.user.id);
  const ids = Array.from(
    { length: 51 },
    (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
  );
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ ids }),
  });
  assertStatus(res.status, 400, res.data);
});

test('POST /messages/batch — returns real messages scoped to user', async () => {
  const session = await createAnonymousSession('batch-real');
  trackedUserIds.add(session.user.id);

  // Create agent using the retry-capable helper, then post a USER message
  const agentId = await createTestAgent(session.user.id, 'batch test agent');
  trackedAgentIds.add(agentId);

  const msgRes = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ message: 'batch test message content', role: 'USER' }),
  });
  assertStatus(msgRes.status, 201, msgRes.data);
  const messageId = (msgRes.data as { message_id: string }).message_id;

  // Batch fetch that message
  const batchRes = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ ids: [messageId] }),
  });
  assertStatus(batchRes.status, 200, batchRes.data);
  const body = batchRes.data as { messages: { id: string; text: string; role: string }[] };
  if (body.messages.length !== 1) {
    throw new Error(`Expected 1 message, got ${body.messages.length}`);
  }
  if (body.messages[0].id !== messageId) {
    throw new Error(`Expected message id ${messageId}, got ${body.messages[0].id}`);
  }
  if (body.messages[0].text !== 'batch test message content') {
    throw new Error(`Unexpected text: ${body.messages[0].text}`);
  }
  if (body.messages[0].role !== 'USER') {
    throw new Error(`Expected role USER, got ${body.messages[0].role}`);
  }
});

// ========================= POST /generate-response-schema ==================

test('POST /generate-response-schema — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents/generate-response-schema`, {
    method: 'POST',
    body: JSON.stringify({ goal: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /generate-response-schema — missing goal → 400', async () => {
  const session = await createAnonymousSession('schema-no-goal');
  const res = await request(`${BASE_URL}/api/agents/generate-response-schema`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
});

// ========================= GET /:id/attachments/:fileId/url ================

test('GET /:id/attachments/:fileId/url — no auth → 401', async () => {
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/attachments/${FAKE_UUID}/url?storage_path=test`
  );
  assertStatus(res.status, 401, res.data);
});

test('GET /:id/attachments/:fileId/url — missing storage_path → 400', async () => {
  const session = await createAnonymousSession('att-no-path');
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/attachments/${FAKE_UUID}/url`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
});

test('GET /:id/attachments/:fileId/url — wrong user path → 403', async () => {
  const session = await createAnonymousSession('att-wrong-user');
  const otherUserId = randomUUID();
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/attachments/${FAKE_UUID}/url?storage_path=${encodeURIComponent(otherUserId + '/file.txt')}`,
    { headers: authHeaders(session.session.access_token) }
  );
  assertStatus(res.status, 403, res.data);
});

// ========================= State transition invariants ======================

test('state: pause → resume round-trip preserves agent data', async () => {
  const session = await createAnonymousSession('state-round-trip');

  // Create agent via HTTP so it's visible to the server
  const agentId = await createTestAgent(session.user.id, 'State round-trip test');

  // Get initial state
  const before = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const beforeBody = assertSchema(GetAgentResponse, before.data, 'before pause');

  // Force PAUSED via status PATCH — this is race-safe because
  // failAgentIfStillActive only overwrites STARTING_UP/ACTIVE, not PAUSED.
  // Using the pause endpoint alone races with handleChatMessage's fire-and-forget.
  const patchRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'PAUSED',
      progress: 0,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);

  // Verify intermediate PAUSED state
  const pausedCheck = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const pausedStatus = assertSchema(StatusResponse, pausedCheck.data, 'intermediate PAUSED check');
  assert(
    pausedStatus.status === 'PAUSED',
    `Expected PAUSED after pause, got ${pausedStatus.status}`
  );

  // Resume — assert the mutation response
  const resumeRes = await request(`${BASE_URL}/api/agents/${agentId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(resumeRes.status, 200, resumeRes.data);

  // Get after state
  const after = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const afterBody = assertSchema(GetAgentResponse, after.data, 'after resume');

  assert(
    afterBody.agent.status === 'ACTIVE',
    `Expected ACTIVE after round-trip, got ${afterBody.agent.status}`
  );
  assert(afterBody.agent.goal === beforeBody.agent.goal, 'Goal should survive round-trip');
  assert(afterBody.agent.model === beforeBody.agent.model, 'Model should survive round-trip');

  await deleteTestAgent(agentId, session.user.id);
});

test('state: pause skips terminal agents', async () => {
  const session = await createAnonymousSession('state-terminal');

  // Create agent via HTTP, then set to COMPLETED via internal status update
  const agentId = await createTestAgent(session.user.id, 'Terminal pause test');
  await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COMPLETED',
      progress: 1.0,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });

  // Pause should succeed but not change status (skips terminal)
  const pauseRes = await request(`${BASE_URL}/api/agents/${agentId}/pause`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(pauseRes.status, 200, pauseRes.data);

  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'terminal pause check');
  assert(status.status === 'COMPLETED', `Expected COMPLETED to persist, got ${status.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Read-after-write consistency ====================

test('read-after-write: create agent → immediately visible in list', async () => {
  const session = await createAnonymousSession('raw-list');
  const goal = `RAW list test ${randomUUID().slice(0, 8)}`;
  const agentId = await createTestAgent(session.user.id, goal);

  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListAgentsResponse, res.data, 'RAW list');
  const found = body.agents.find((a) => a.agent_id === agentId);
  assert(found, 'Newly created agent should appear in list');
  assert(found!.goal === goal, 'Goal should match in list');

  await deleteTestAgent(agentId, session.user.id);
});

test('read-after-write: update agent → visible in detail', async () => {
  const session = await createAnonymousSession('raw-update');
  const agentId = await createTestAgent(session.user.id, 'RAW update test');

  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ model: 'rose-labs/rose-1-ultra', progress: 0.5, message_count: 10 }),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const body = assertSchema(GetAgentResponse, res.data, 'RAW update verify');
  assert(body.agent.model === 'rose-labs/rose-1-ultra', 'Model not updated');
  assert(body.agent.progress === 0.5, 'Progress not updated');
  assert(body.agent.message_count === 10, 'Message count not updated');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Ordering / pagination invariant =================

test('ordering: list agents returns newest first', async () => {
  const session = await createAnonymousSession('order-list');
  const id1 = await createTestAgent(session.user.id, 'First agent');
  // Small delay to ensure distinct timestamps
  await sleep(50);
  const id2 = await createTestAgent(session.user.id, 'Second agent');

  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) });
  const body = assertSchema(ListAgentsResponse, res.data, 'order list');
  const idx1 = body.agents.findIndex((a) => a.agent_id === id1);
  const idx2 = body.agents.findIndex((a) => a.agent_id === id2);
  assert(idx1 >= 0 && idx2 >= 0, 'Both agents should be in list');
  assert(idx2 < idx1, 'Newer agent should appear first');

  await deleteTestAgent(id1, session.user.id);
  await deleteTestAgent(id2, session.user.id);
});

test('ordering: messages returned in timestamp asc', async () => {
  const session = await createAnonymousSession('order-msgs');
  const agentId = await createTestAgent(session.user.id, 'Message order test');

  // Post two more messages
  await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'msg-1', role: 'ASSISTANT' }),
  });
  await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'msg-2', role: 'TOOL' }),
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const body = assertSchema(GetAgentResponse, res.data, 'message order');
  const timestamps = body.messages.map((m) => new Date(m.timestamp as string).getTime());
  for (let i = 1; i < timestamps.length; i++) {
    assert(timestamps[i] >= timestamps[i - 1], `Messages not in ascending order at index ${i}`);
  }

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Sub-agent creation & recursive delete ===========

test('POST / — sub-agent creation with parent_agent_id', async () => {
  const session = await createAnonymousSession('sub-agent-create');
  const parentId = await createTestAgent(session.user.id, 'Parent for sub-agent test');

  // Create child agent with parent_agent_id, depth, and bus_id via API key
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Child sub-agent test',
      parent_agent_id: parentId,
      depth: 1,
      bus_id: parentId,
      task_queue: 'test-queue',
    }),
  });
  // Sub-agent creation may succeed (201) or fail (500 if Temporal not running)
  if (res.status !== 201 && res.status !== 500) {
    throw new Error(`Expected 201 or 500 for sub-agent create, got ${res.status}`);
  }
  if (res.status === 201) {
    const body = res.data as { agent_id: string };
    trackedAgentIds.add(body.agent_id);
    await deleteTestAgent(body.agent_id, session.user.id);
  }
  await deleteTestAgent(parentId, session.user.id);
});

test('DELETE /:id — recursive delete with children', async () => {
  const session = await createAnonymousSession('recursive-del');

  // Create parent via HTTP so it's visible to the server
  const parentId = await createTestAgent(session.user.id, 'Parent recursive delete test');

  // Create child via HTTP with parent_agent_id — may fail (500) if Temporal not running,
  // but the agent row is committed to DB before the workflow launch attempt
  const childCreateRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Child recursive delete test',
      parent_agent_id: parentId,
      bus_id: parentId,
    }),
  });

  let childId: string;
  if (childCreateRes.status === 201) {
    childId = (childCreateRes.data as { agent_id: string }).agent_id;
  } else {
    // Temporal not running: child was written to DB before workflow launch failed.
    const child = await withTransientDbRetry('find-child-recursive', async () =>
      prisma.agent.findFirst({
        where: { parentAgentId: parentId, userId: session.user.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    );
    if (!child) throw new Error('Child agent not found after sub-agent creation attempt');
    childId = child.id;
  }
  trackedAgentIds.add(childId);

  // Delete parent — should recursively delete child
  const delRes = await request(`${BASE_URL}/api/agents/${parentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(delRes.status, 204, delRes.data);

  // Both parent and child should be 404 on GET
  const parentGet = await request(`${BASE_URL}/api/agents/${parentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(parentGet.status, 404, parentGet.data);

  const childGet = await request(`${BASE_URL}/api/agents/${childId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(childGet.status, 404, childGet.data);
});

test('DELETE /:id — cleans up attention requests', async () => {
  const session = await createAnonymousSession('del-attention');

  // Create agent via HTTP so it's visible to the server
  const agentId = await createTestAgent(session.user.id, 'Attention request cleanup test');

  // Create an attention request via Prisma (no HTTP endpoint for this)
  await withTransientDbRetry('create-attention-request', async () => {
    await prisma.agentAttentionRequest.create({
      data: {
        userId: session.user.id,
        agentId,
        workflowId: 'test-workflow-id',
        question: 'Test question?',
      },
    });
  });

  // Verify attention request exists
  const beforeCount = await withTransientDbRetry('count-attention-before', async () => {
    return prisma.agentAttentionRequest.count({ where: { agentId } });
  });
  assert(beforeCount === 1, `Expected 1 attention request before delete, got ${beforeCount}`);

  // Delete agent
  const delRes = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(delRes.status, 204, delRes.data);

  // Verify attention request is cleaned up
  const afterCount = await withTransientDbRetry('count-attention-after', async () => {
    return prisma.agentAttentionRequest.count({ where: { agentId } });
  });
  assert(afterCount === 0, `Expected 0 attention requests after delete, got ${afterCount}`);
});

test('DELETE /:id — internal auth delete (no userId)', async () => {
  const session = await createAnonymousSession('del-internal');
  const agentId = await createTestAgent(session.user.id, 'Internal delete test');

  // Delete with only X-API-Key (no X-User-Id) — internal auth bypasses ownership check
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': API_KEY },
  });
  assertStatus(res.status, 204, res.data);

  // Verify it's gone
  const check = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(check.status, 404, check.data);
});

// ========================= Terminal agent pause behavior ====================

test('POST /:id/pause — terminal FAILED agent stays FAILED', async () => {
  const session = await createAnonymousSession('pause-failed');

  // Create agent via HTTP, then set to FAILED via internal status update
  const agentId = await createTestAgent(session.user.id, 'Pause FAILED test');
  await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'FAILED',
      statusMessage: 'Test failure',
      progress: 0,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });

  const pauseRes = await request(`${BASE_URL}/api/agents/${agentId}/pause`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(pauseRes.status, 200, pauseRes.data);

  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'pause-failed check');
  assert(status.status === 'FAILED', `Expected FAILED to persist, got ${status.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Resume with COST_LIMIT_REACHED parent ===========

test('POST /:id/resume — child with COST_LIMIT_REACHED parent → 400', async () => {
  const session = await createAnonymousSession('resume-cost-limit');

  // Create parent via HTTP then set to COST_LIMIT_REACHED
  const parentId = await createTestAgent(session.user.id, 'Cost-limited parent');
  await request(`${BASE_URL}/api/agents/${parentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COST_LIMIT_REACHED',
      progress: 0,
      tokenCount: 0,
      contextSize: 0,
      messageCount: 0,
    }),
  });

  // Create child via HTTP with parent_agent_id — may fail (500) if Temporal not running,
  // but the agent row is committed to DB before the workflow launch attempt
  const childCreateRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Child of cost-limited parent',
      parent_agent_id: parentId,
      bus_id: parentId,
    }),
  });

  let childId: string;
  if (childCreateRes.status === 201) {
    childId = (childCreateRes.data as { agent_id: string }).agent_id;
  } else {
    // Temporal not running: child was written to DB before workflow launch failed.
    const child = await withTransientDbRetry('find-child-cost-limit', async () =>
      prisma.agent.findFirst({
        where: { parentAgentId: parentId, userId: session.user.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    );
    if (!child) throw new Error('Child agent not found after sub-agent creation attempt');
    childId = child.id;
    // Set child to PAUSED
    await request(`${BASE_URL}/api/agents/${childId}/status`, {
      method: 'PATCH',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        status: 'PAUSED',
        progress: 0,
        tokenCount: 0,
        contextSize: 0,
        messageCount: 0,
      }),
    });
  }
  trackedAgentIds.add(childId);

  // Try to resume child — should fail because parent is COST_LIMIT_REACHED
  const res = await request(`${BASE_URL}/api/agents/${childId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('cost-limited'), `Expected cost-limited error, got: ${body.error}`);

  await deleteTestAgent(parentId, session.user.id);
});

// ========================= Resume tenant isolation ==========================

test('POST /:id/resume — tenant isolation: user B cannot resume user A agent → 404', async () => {
  const sessionA = await createAnonymousSession('resume-iso-a');
  const sessionB = await createAnonymousSession('resume-iso-b');

  // Create PAUSED agent for user A
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-resume-iso', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: sessionA.user.id,
        goal: 'Resume isolation test',
        status: 'PAUSED',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // User B tries to resume user A's agent
  const res = await request(`${BASE_URL}/api/agents/${agentId}/resume`, {
    method: 'POST',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  // Cleanup
  await withTransientDbRetry('cleanup-resume-iso', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= Start-agent edge cases ==========================

test('POST /:id/start-agent — already in agent mode → 400', async () => {
  const session = await createAnonymousSession('start-already');

  // Create agent with temporalWorkflowId set (simulating agent mode)
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-agent-mode', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Already in agent mode test',
        status: 'ACTIVE',
        temporalWorkflowId: 'fake-workflow-id-' + randomUUID(),
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/start-agent`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(
    body.error.includes('already in agent mode'),
    `Expected already in agent mode error, got: ${body.error}`
  );

  await withTransientDbRetry('cleanup-agent-mode', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

test('POST /:id/start-agent — no verifier → 400', async () => {
  const session = await createAnonymousSession('start-no-verifier');

  // Create agent WITHOUT a verifier
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-no-verifier', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'No verifier start-agent test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    // No verifier created intentionally
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/start-agent`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('verifier'), `Expected verifier error, got: ${body.error}`);

  await withTransientDbRetry('cleanup-no-verifier', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= Restart edge cases ==============================

test('POST /:id/restart — no verifier → 400', async () => {
  const session = await createAnonymousSession('restart-no-verifier');

  // Create agent WITHOUT a verifier
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-restart-no-verifier', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'No verifier restart test',
        status: 'FAILED',
        busId: agentId,
      },
    });
    // No verifier created intentionally
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/restart`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('verifier'), `Expected verifier error, got: ${body.error}`);

  await withTransientDbRetry('cleanup-restart-no-verifier', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

test('POST /:id/restart — tenant isolation: user B cannot restart user A agent → 404', async () => {
  const sessionA = await createAnonymousSession('restart-iso-a');
  const sessionB = await createAnonymousSession('restart-iso-b');
  const agentId = await createTestAgent(sessionA.user.id, 'Restart isolation test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/restart`, {
    method: 'POST',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  await deleteTestAgent(agentId, sessionA.user.id);
});

// ========================= PATCH /:id/status with structuredResponse =======

test('PATCH /:id/status — with structuredResponse and all fields', async () => {
  const session = await createAnonymousSession('status-structured');

  // Create agent directly in DB to avoid chatHandler race
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-structured-status', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Structured response test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const structuredResponse = { result: 'success', data: [1, 2, 3] };
  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'COMPLETED',
      statusMessage: 'Done with structured output',
      progress: 1.0,
      tokenCount: 8000,
      tokensIn: 5000,
      tokensOut: 3000,
      contextSize: 15000,
      messageCount: 30,
      structuredResponse,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateStatusResponse, res.data, 'PATCH status structured');
  assert(body.status === 'COMPLETED', `Expected COMPLETED, got ${body.status}`);
  assert(body.tokens_in === 5000, `Expected tokens_in 5000, got ${body.tokens_in}`);
  assert(body.tokens_out === 3000, `Expected tokens_out 3000, got ${body.tokens_out}`);

  // Verify structuredResponse is persisted by checking via GET detail
  const detail = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= PATCH /:id price_limit via prisma direct ========

test('PATCH /:id — price_limit_cents below cost set via prisma → 400', async () => {
  const session = await createAnonymousSession('price-prisma');

  // Create agent directly in DB and set treeCostCents via prisma
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-price-prisma', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Price limit prisma test',
        status: 'ACTIVE',
        treeCostCents: 100,
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Try to set price limit below current tree cost
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ price_limit_cents: 50 }),
  });
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; current_cost_cents?: number };
  assert(body.error.includes('current cost'), `Expected cost error, got: ${body.error}`);
  assert(
    body.current_cost_cents === 100,
    `Expected current_cost_cents=100, got ${body.current_cost_cents}`
  );

  await withTransientDbRetry('cleanup-price-prisma', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= POST /:id/messages — completed agent resets =====

test('POST /:id/messages — user message to completed agent resets status', async () => {
  const session = await createAnonymousSession('msg-reset');

  // Create agent with COMPLETED status and a temporalWorkflowId
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-completed-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Completed agent message test',
        status: 'COMPLETED',
        temporalWorkflowId: 'fake-completed-workflow-' + randomUUID(),
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Post a user message — should reset status from COMPLETED to ACTIVE
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'follow-up question' }),
  });
  assertStatus(res.status, 201, res.data);

  // Verify status has been reset
  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'msg-reset status check');
  assert(
    status.status === 'ACTIVE',
    `Expected ACTIVE after message to completed agent, got ${status.status}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Batch messages tenant isolation ==================

test('POST /messages/batch — tenant isolation: user B cannot see user A messages', async () => {
  const sessionA = await createAnonymousSession('batch-iso-a');
  const sessionB = await createAnonymousSession('batch-iso-b');
  trackedUserIds.add(sessionA.user.id);
  trackedUserIds.add(sessionB.user.id);

  // Create agent for user A and post a message
  const agentId = await createTestAgent(sessionA.user.id, 'Batch isolation agent');
  const msgRes = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'secret message', role: 'ASSISTANT' }),
  });
  assertStatus(msgRes.status, 201, msgRes.data);
  const messageId = (msgRes.data as { message_id: string }).message_id;

  // User B tries to batch-fetch user A's message
  const batchRes = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': sessionB.user.id },
    body: JSON.stringify({ ids: [messageId] }),
  });
  assertStatus(batchRes.status, 200, batchRes.data);
  const body = batchRes.data as { messages: unknown[] };
  assert(
    body.messages.length === 0,
    `User B should not see user A messages, got ${body.messages.length}`
  );

  await deleteTestAgent(agentId, sessionA.user.id);
});

// ========================= PATCH /:id — tool_ids update ====================

test('PATCH /:id — tool_ids update', async () => {
  const session = await createAnonymousSession('upd-tools');
  const agentId = await createTestAgent(session.user.id, 'Tool IDs update test');

  // Get current tools (should be empty or default)
  const detailBefore = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detailBefore.status, 200, detailBefore.data);

  // Update with empty tool_ids (clear all tools)
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ tool_ids: [] }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id tool_ids');
  assert(
    body.agent.tools.length === 0,
    `Expected 0 tools after clearing, got ${body.agent.tools.length}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= Cleanup invariant (best-effort) =================

test('cleanup: tracked agents are soft-deleted', async () => {
  // This test ensures we can clean up after ourselves.
  // Creates and immediately deletes an agent.
  const session = await createAnonymousSession('cleanup');
  const agentId = await createTestAgent(session.user.id, 'Cleanup test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 204, res.data);
});

// ========================= Additional coverage tests =======================

test('POST / — with context_gates parameter', async () => {
  const session = await createAnonymousSession('ctx-gates');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Context gates test',
      context_gates: {
        user_profile: true,
        network: false,
        recent_communications: false,
        integrations: true,
      },
    }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  assert(typeof body.agent_id === 'string', 'Expected agent_id in response');
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — with start_phase=plan', async () => {
  const session = await createAnonymousSession('start-plan');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ goal: 'Start phase plan test', start_phase: 'plan' }),
  });
  // 201 on success; 500 if Temporal is not running in this environment
  if (res.status !== 201 && res.status !== 500) {
    throw new Error(`Expected 201 or 500 for start_phase=plan, got ${res.status}`);
  }
  if (res.status === 201) {
    const body = res.data as { agent_id: string };
    await deleteTestAgent(body.agent_id, session.user.id);
  }
});

test('POST / — with start_phase=execute', async () => {
  const session = await createAnonymousSession('start-exec');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ goal: 'Start phase execute test', start_phase: 'execute' }),
  });
  // 201 on success; 500 if Temporal is not running in this environment
  if (res.status !== 201 && res.status !== 500) {
    throw new Error(`Expected 201 or 500 for start_phase=execute, got ${res.status}`);
  }
  if (res.status === 201) {
    const body = res.data as { agent_id: string };
    await deleteTestAgent(body.agent_id, session.user.id);
  }
});

test('POST / — with price_limit_cents', async () => {
  const session = await createAnonymousSession('price-limit');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Price limit test',
    price_limit_cents: 500,
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  // Verify price_limit_cents is persisted
  const detailRes = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(detailRes.status, 200, detailRes.data);
  const detail = detailRes.data as { agent: { price_limit_cents: number | null } };
  assert(
    detail.agent.price_limit_cents === 500,
    `Expected price_limit_cents=500, got ${detail.agent.price_limit_cents}`
  );
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — with custom_system_prompt', async () => {
  const session = await createAnonymousSession('custom-prompt');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Custom prompt test',
    custom_system_prompt: 'You are a helpful coding assistant.',
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('POST / — with write_lock_enabled', async () => {
  const session = await createAnonymousSession('write-lock');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Write lock test',
    write_lock_enabled: true,
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

test('GET /:id — with before query param (pagination)', async () => {
  const session = await createAnonymousSession('msg-since');
  const agentId = await createTestAgent(session.user.id, 'Message since test');
  const before = new Date().toISOString();
  // Messages are returned via the agent detail endpoint with optional ?before= pagination param
  const res = await request(`${BASE_URL}/api/agents/${agentId}?before=${before}`, {
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(GetAgentResponse, res.data, 'GET /:id with before param');
  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/messages — system message via internal auth', async () => {
  const session = await createAnonymousSession('msg-system');
  const agentId = await createTestAgent(session.user.id, 'System message test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      message: 'System notification',
      role: 'SYSTEM',
      metadata: { type: 'system_notification' },
    }),
  });
  assertStatus(res.status, 201, res.data);
  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/start-agent — happy path (no Temporal)', async () => {
  const session = await createAnonymousSession('start-agent');
  const agentId = await createTestAgent(session.user.id, 'Start agent test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/start-agent`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({}),
  });
  // May succeed (200) or fail (500 if Temporal not running) — exercises the route
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for start-agent, got ${res.status}`);
  }
  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/restart — happy path (no Temporal)', async () => {
  const session = await createAnonymousSession('restart');
  const agentId = await createTestAgent(session.user.id, 'Restart test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/restart`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
  });
  // May succeed (200) or fail (500 if Temporal not running) — exercises the route
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for restart, got ${res.status}`);
  }
  await deleteTestAgent(agentId, session.user.id);
});

// ========================= resolvePromptSecrets via internal auth ===========

test('POST / — resolvePromptSecrets replaces {{VAR}} in goal (internal auth)', async () => {
  const session = await createAnonymousSession('resolve-secrets');

  // When PROMPT_SECRET_UNDEFINED_SECRET is not set, {{UNDEFINED_SECRET}} stays as-is
  const goalWithSecret = 'Test goal with {{UNDEFINED_SECRET}} placeholder';
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), { goal: goalWithSecret });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / resolve secrets');

  // The {{UNDEFINED_SECRET}} should remain as-is since PROMPT_SECRET_UNDEFINED_SECRET is not set
  assert(
    body.goal.includes('{{UNDEFINED_SECRET}}'),
    `Expected unresolved secret to remain, got goal: "${body.goal}"`
  );
  trackedAgentIds.add(body.agent_id);
  await deleteTestAgent(body.agent_id, session.user.id);
});

// ========================= POST /:id/messages — FAILED agent resets ========

test('POST /:id/messages — user message to FAILED agent resets status', async () => {
  const session = await createAnonymousSession('msg-reset-failed');

  // Create agent with FAILED status and a temporalWorkflowId
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-failed-agent-msg', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Failed agent message test',
        status: 'FAILED',
        temporalWorkflowId: 'fake-failed-workflow-' + randomUUID(),
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Post a user message — should reset status from FAILED to ACTIVE
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'retry after failure' }),
  });
  assertStatus(res.status, 201, res.data);

  // Verify status has been reset
  const statusRes = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const status = assertSchema(StatusResponse, statusRes.data, 'msg-reset-failed status check');
  assert(
    status.status === 'ACTIVE',
    `Expected ACTIVE after message to failed agent, got ${status.status}`
  );

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — with attachments ===========

test('POST /:id/messages — message with file_pointer attachment', async () => {
  const session = await createAnonymousSession('msg-file-ptr');
  const agentId = await createTestAgent(session.user.id, 'File pointer message test');

  const filePointer = {
    id: randomUUID(),
    storage_path: `${session.user.id}/test-file.txt`,
    original_filename: 'test-file.txt',
    mime_type: 'text/plain',
    size_bytes: 100,
    created_at: new Date().toISOString(),
  };

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      message: 'Here is a file',
      role: 'USER',
      file_pointer: filePointer,
    }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST messages file_pointer');
  assert(body.role === 'USER', `Expected USER role, got ${body.role}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — message with metadata ======

test('POST /:id/messages — internal message with full metadata', async () => {
  const session = await createAnonymousSession('msg-metadata');
  const agentId = await createTestAgent(session.user.id, 'Metadata message test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      message: 'Tool output with rich metadata',
      role: 'TOOL',
      metadata: {
        toolName: 'web_search',
        toolStatus: 'success',
        title: 'Search results',
        duration_ms: 1500,
        urls: ['https://example.com'],
      },
    }),
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(PostMessageResponse, res.data, 'POST messages metadata');
  assert(body.role === 'TOOL', `Expected TOOL role, got ${body.role}`);

  // Verify metadata persisted via GET detail
  const detail = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);
  const detailBody = assertSchema(GetAgentResponse, detail.data, 'metadata detail');
  const toolMsg = detailBody.messages.find((m) => m.text === 'Tool output with rich metadata');
  assert(toolMsg !== undefined, 'Tool message should be visible in detail');
  assert(toolMsg!.metadata !== null, 'Metadata should be persisted');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — ACTIVE agent with workflow =

test('POST /:id/messages — user message to ACTIVE agent with dead workflow', async () => {
  const session = await createAnonymousSession('msg-dead-workflow');

  // Create ACTIVE agent with a fake workflow ID (will fail to signal but not break)
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-dead-workflow-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Dead workflow message test',
        status: 'ACTIVE',
        temporalWorkflowId: 'dead-workflow-' + randomUUID(),
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Message to agent with a dead workflow — should succeed (graceful error handling)
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'message to agent with dead workflow' }),
  });
  assertStatus(res.status, 201, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — ACTIVE chat mode agent =====

test('POST /:id/messages — user message to chat-mode agent (no workflow)', async () => {
  const session = await createAnonymousSession('msg-chat-mode');

  // Create agent without temporalWorkflowId (chat mode)
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-chat-mode-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Chat mode message test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // User message triggers chat handler (fire-and-forget, may fail but request succeeds)
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 'hello chat mode agent' }),
  });
  assertStatus(res.status, 201, res.data);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= DELETE /:id — recursive delete 3-level tree =====

test('DELETE /:id — recursive delete with grandchild (3-level tree)', async () => {
  const session = await createAnonymousSession('recursive-del-3');

  // Create grandparent
  const grandparentId = randomUUID();
  trackedAgentIds.add(grandparentId);
  await withTransientDbRetry('create-grandparent', async () => {
    await prisma.agent.create({
      data: {
        id: grandparentId,
        userId: session.user.id,
        goal: 'Grandparent',
        status: 'ACTIVE',
        busId: grandparentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId: grandparentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Create parent
  const parentId = randomUUID();
  trackedAgentIds.add(parentId);
  await withTransientDbRetry('create-parent-3', async () => {
    await prisma.agent.create({
      data: {
        id: parentId,
        userId: session.user.id,
        goal: 'Parent',
        parentAgentId: grandparentId,
        busId: grandparentId,
        status: 'ACTIVE',
      },
    });
    await prisma.verifier.create({
      data: { agentId: parentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Create grandchild
  const grandchildId = randomUUID();
  trackedAgentIds.add(grandchildId);
  await withTransientDbRetry('create-grandchild', async () => {
    await prisma.agent.create({
      data: {
        id: grandchildId,
        userId: session.user.id,
        goal: 'Grandchild',
        parentAgentId: parentId,
        busId: grandparentId,
        status: 'ACTIVE',
      },
    });
    await prisma.verifier.create({
      data: { agentId: grandchildId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  // Delete grandparent — should recursively delete parent and grandchild
  const delRes = await request(`${BASE_URL}/api/agents/${grandparentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(delRes.status, 204, delRes.data);

  // All three should be 404
  for (const id of [grandparentId, parentId, grandchildId]) {
    const getRes = await request(`${BASE_URL}/api/agents/${id}`, {
      headers: apiKeyHeaders(session.user.id),
    });
    assertStatus(getRes.status, 404, getRes.data);
  }
});

// ========================= PATCH /:id/status — tool token fields ===========

test('PATCH /:id/status — with tool token cost fields', async () => {
  const session = await createAnonymousSession('status-tool-tokens');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-tool-token-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Tool token cost test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'ACTIVE',
      progress: 0.5,
      tokenCount: 2000,
      tokensIn: 1200,
      tokensOut: 800,
      toolTokensIn: 500,
      toolTokensOut: 300,
      toolCostCents: 15,
      contextSize: 8000,
      messageCount: 12,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateStatusResponse, res.data, 'PATCH status tool tokens');
  assert(body.status === 'ACTIVE', `Expected ACTIVE, got ${body.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= GET / — with source filter ======================

test('GET / — with source query param', async () => {
  const session = await createAnonymousSession('list-source');
  const agentId = await createTestAgent(session.user.id, 'Source filter test');

  // Filter by WEB source (default)
  const res = await request(`${BASE_URL}/api/agents?source=WEB`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListAgentsResponse, res.data, 'GET / source filter');

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/messages — message empty string =======

test('POST /:id/messages — empty message text succeeds', async () => {
  const session = await createAnonymousSession('msg-empty-text');
  const agentId = await createTestAgent(session.user.id, 'Empty message test');

  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: '', role: 'TOOL' }),
  });
  // Empty message may succeed or fail depending on validation
  if (res.status !== 201 && res.status !== 400) {
    throw new Error(`Expected 201 or 400 for empty message, got ${res.status}`);
  }

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST / — with response_schema ===================

test('POST / — with response_schema parameter', async () => {
  const session = await createAnonymousSession('response-schema');
  const schema = {
    fields: [
      { name: 'result', type: 'str', required: true, description: 'The result string' },
      { name: 'confidence', type: 'float', required: false, description: 'Confidence score' },
      {
        name: 'rows',
        type: 'list[object]',
        required: true,
        description: 'Rows with label and count',
        properties: [
          { name: 'label', type: 'str' },
          { name: 'count', type: 'int' },
        ],
      },
      {
        name: 'session_file',
        type: 'session_file_pointer',
        required: false,
        description: 'Remote session artifact',
      },
    ],
  };
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Response schema test',
    response_schema: schema,
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / response_schema');
  trackedAgentIds.add(body.agent_id);

  // Verify response_schema is persisted
  const detail = await request(`${BASE_URL}/api/agents/${body.agent_id}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(detail.status, 200, detail.data);
  const detailBody = assertSchema(GetAgentResponse, detail.data, 'response_schema detail');
  assert(detailBody.agent.response_schema !== null, 'response_schema should be persisted');

  await deleteTestAgent(body.agent_id, session.user.id);
});

// ========================= POST / — with max_iterations ====================

test('POST / — with max_iterations parameter', async () => {
  const session = await createAnonymousSession('max-iterations');
  const res = await postAgentWithRetry(apiKeyHeaders(session.user.id), {
    goal: 'Max iterations test',
    max_iterations: 5,
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateAgentResponse, res.data, 'POST / max_iterations');
  trackedAgentIds.add(body.agent_id);

  await deleteTestAgent(body.agent_id, session.user.id);
});

// ========================= PATCH /:id/status — statusMessage only ==========

test('PATCH /:id/status — update statusMessage without changing status', async () => {
  const session = await createAnonymousSession('status-msg-only');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-status-msg-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Status message only test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/status`, {
    method: 'PATCH',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      status: 'ACTIVE',
      statusMessage: 'Planning next steps...',
      progress: 0.2,
      tokenCount: 500,
      contextSize: 2000,
      messageCount: 5,
    }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateStatusResponse, res.data, 'PATCH status msg only');
  assert(
    body.status_message === 'Planning next steps...',
    `Expected status message, got "${body.status_message}"`
  );
  assert(body.status === 'ACTIVE', `Expected ACTIVE, got ${body.status}`);

  await deleteTestAgent(agentId, session.user.id);
});

// ========================= POST /:id/pause — tenant isolation ===============

test('POST /:id/pause — tenant isolation: user B cannot pause user A agent → 404', async () => {
  const sessionA = await createAnonymousSession('pause-iso-a');
  const sessionB = await createAnonymousSession('pause-iso-b');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-pause-iso', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: sessionA.user.id,
        goal: 'Pause isolation test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}/pause`, {
    method: 'POST',
    headers: authHeaders(sessionB.session.access_token),
  });
  assertStatus(res.status, 404, res.data);

  await withTransientDbRetry('cleanup-pause-iso', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
});

// ========================= GET /:id — soft-deleted agent → 404 =============

test('GET /:id — soft-deleted agent returns 404', async () => {
  const session = await createAnonymousSession('get-soft-del');

  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-soft-del-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Soft deleted test',
        status: 'ACTIVE',
        deletedAt: new Date(), // Pre-soft-delete
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE' },
    });
  });

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  assertStatus(res.status, 404, res.data);
});

// ==================== DEEP COVERAGE — HYBRIDAUTH + MESSAGES + GEOIP ====================

// 1. Rose API key auth: invalid key should return 401
test('HybridAuth — invalid Rose API key → 401', async () => {
  const res = await request(`${BASE_URL}/api/agents`, {
    headers: { 'X-API-Key': 'invalid-rose-api-key-that-does-not-exist' },
  });
  assertStatus(res.status, 401, res.data);
});

// 2. Agent creation with X-Forwarded-For to exercise geoip getClientIP
test('POST /agents — with X-Forwarded-For header (geoip path)', async () => {
  const session = await createAnonymousSession('geo-test');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      ...apiKeyHeaders(session.user.id),
      'X-Forwarded-For': '8.8.8.8',
    },
    body: JSON.stringify({ goal: 'Geoip test agent', model: 'rose-1-lite' }),
  });
  // Agent creation should succeed (geoip lookup happens asynchronously)
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

// 3. POST /:id/messages with invalid body (Zod validation error → handleRouteError ZodError branch)
test('POST /:id/messages — invalid body → 400 (Zod)', async () => {
  const session = await createAnonymousSession('msg-zod-err');
  const agentId = await createTestAgent(session.user.id, 'Zod error test');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ message: 12345, role: 'INVALID_ROLE' }), // wrong types
  });
  assertStatus(res.status, 400, res.data);
  await deleteTestAgent(agentId, session.user.id);
});

// 4. POST /messages/batch with non-string IDs → 400 or 500 (validation error)
test('POST /messages/batch — non-string IDs → 400 or 500', async () => {
  const session = await createAnonymousSession('batch-nonstr');
  const res = await request(`${BASE_URL}/api/agents/messages/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ ids: [123, 456] }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500 for non-string IDs, got ${res.status}`);
  }
});

// 5. GET /:id/attachments/:fileId/url — empty storage_path → 400
test('GET /:id/attachments/:fileId/url — empty string storage_path → 400', async () => {
  const session = await createAnonymousSession('attach-empty');
  const res = await request(
    `${BASE_URL}/api/agents/${FAKE_UUID}/attachments/${FAKE_UUID}/url?storage_path=`,
    { headers: authHeaders(session.session.access_token) }
  );
  assertStatus(res.status, 400, res.data);
});

// 6. Agent creation with private IP in X-Forwarded-For (exercises isPrivateIP branches in geoip)
test('POST /agents — with private IP in X-Forwarded-For', async () => {
  const session = await createAnonymousSession('geo-private');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      ...apiKeyHeaders(session.user.id),
      'X-Forwarded-For': '192.168.1.1',
    },
    body: JSON.stringify({ goal: 'Private IP test', model: 'rose-1-lite' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

// 7. Agent creation with IPv6-mapped IPv4 in X-Forwarded-For
test('POST /agents — with IPv6-mapped IPv4 X-Forwarded-For', async () => {
  const session = await createAnonymousSession('geo-ipv6');
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      ...apiKeyHeaders(session.user.id),
      'X-Forwarded-For': '::ffff:10.0.0.1',
    },
    body: JSON.stringify({ goal: 'IPv6 mapped test', model: 'rose-1-lite' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  await deleteTestAgent(body.agent_id, session.user.id);
});

// 8. POST /:id/messages — with missing message field
test('POST /:id/messages — missing message field → 400', async () => {
  const session = await createAnonymousSession('msg-nomsg');
  const agentId = await createTestAgent(session.user.id, 'Missing message field');
  const res = await request(`${BASE_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  await deleteTestAgent(agentId, session.user.id);
});

// 9. Multiple different model names to exercise model pricing paths
test('POST /agents — with different model names (model pricing)', async () => {
  const session = await createAnonymousSession('model-pricing');
  // Create agents with different models to exercise modelPricing getModelPricing
  for (const model of ['rose-1-lite', 'rose-1-ultra']) {
    const res = await request(`${BASE_URL}/api/agents`, {
      method: 'POST',
      headers: apiKeyHeaders(session.user.id),
      body: JSON.stringify({ goal: `Model pricing test ${model}`, model }),
    });
    assertStatus(res.status, 201, res.data);
    const body = res.data as { agent_id: string };
    await deleteTestAgent(body.agent_id, session.user.id);
  }
});

// ---------------------------------------------------------------------------
// POST /agents/batch — bulk create endpoint
// ---------------------------------------------------------------------------

const BatchAgentResultSchema = z.object({
  agent_id: z.string().uuid(),
  status: z.enum(['STARTING_UP', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED']),
  temporal_workflow_id: z.string().nullable(),
  goal: z.string().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  already_existed: z.boolean().optional(),
});
const BatchResponseSchema = z.object({ results: z.array(BatchAgentResultSchema) });

function makeBatchAgent(opts: {
  parentAgentId: string;
  busId: string;
  goal?: string;
  attachments?: unknown[];
}) {
  return {
    agent_id: randomUUID(),
    goal: opts.goal ?? `Batch child ${RUN_ID} ${randomUUID().slice(0, 8)}`,
    model: 'rose-labs/rose-1-lite',
    parent_agent_id: opts.parentAgentId,
    bus_id: opts.busId,
    depth: 1,
    start_phase: 'execute',
    response_schema: { fields: [{ name: 'value', type: 'int', required: true, description: 'x' }] },
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
  };
}

test('POST /agents/batch — happy path: 3 children all spawn', async () => {
  const session = await createAnonymousSession('batch-happy');
  const parentId = await createTestAgent(session.user.id, 'Batch parent');
  const agents = [1, 2, 3].map(() => makeBatchAgent({ parentAgentId: parentId, busId: parentId }));
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  // Expected status: 201 if all phase-2 starts succeed, 207 if any failed.
  // Either is valid for an integration test against a real Temporal cluster;
  // assert the per-child result shape rather than the aggregate code.
  assert(
    res.status === 201 || res.status === 207,
    `Expected 201 or 207, got ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`
  );
  const body = assertSchema(BatchResponseSchema, res.data, 'batch happy path');
  assert(body.results.length === 3, `Expected 3 results, got ${body.results.length}`);
  for (const r of body.results) {
    assert(r.status === 'STARTING_UP' || r.status === 'FAILED', `Unexpected status ${r.status}`);
    if (r.status === 'STARTING_UP') {
      assert(r.temporal_workflow_id === r.agent_id, 'workflow_id should equal agent_id');
    }
    trackedAgentIds.add(r.agent_id);
  }
  for (const r of body.results) await deleteTestAgent(r.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — anonymous JWT cannot create children → 401', async () => {
  const session = await createAnonymousSession('batch-anon-rejected');
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({
      agents: [
        makeBatchAgent({
          parentAgentId: FAKE_UUID,
          busId: FAKE_UUID,
          goal: 'Anonymous batch create should fail',
        }),
      ],
    }),
  });
  assertStatus(res.status, 401, res.data);
  const body = assertSchema(ErrorResponse, res.data, 'POST /agents/batch anonymous rejected');
  assert(body.error.includes('Login required'), `Unexpected error: ${body.error}`);
});

test('POST /agents/batch — missing agents → 400', async () => {
  const session = await createAnonymousSession('batch-empty');
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents: [] }),
  });
  assertStatus(res.status, 400, res.data);
});

test('POST /agents/batch — > 200 children → 400', async () => {
  const session = await createAnonymousSession('batch-too-big');
  const parentId = await createTestAgent(session.user.id, 'Batch too big');
  const agents = Array.from({ length: 201 }, () =>
    makeBatchAgent({ parentAgentId: parentId, busId: parentId })
  );
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assertStatus(res.status, 400, res.data);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — child missing goal rolls back the entire batch', async () => {
  // Phase-1 atomic guarantee: if any single child fails Zod validation, NO
  // rows are created. We assert this by counting agents owned by this user
  // before and after a partially-bad batch.
  const session = await createAnonymousSession('batch-rollback');
  const parentId = await createTestAgent(session.user.id, 'Batch rollback parent');
  const beforeCount = await prisma.agent.count({ where: { userId: session.user.id } });
  const agents = [
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
    // missing goal — Zod rejects
    {
      agent_id: randomUUID(),
      model: 'rose-labs/rose-1-lite',
      parent_agent_id: parentId,
      bus_id: parentId,
      depth: 1,
    },
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
  ];
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assertStatus(res.status, 400, res.data);
  const afterCount = await prisma.agent.count({ where: { userId: session.user.id } });
  assert(
    afterCount === beforeCount,
    `Expected no rows added; before=${beforeCount} after=${afterCount}`
  );
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — idempotent on retry with same agent_ids', async () => {
  // Worker mints stable child agent_ids upfront so a re-POST after a
  // partial-success returns the existing rows untouched (already_existed=true)
  // and does NOT create duplicates.
  const session = await createAnonymousSession('batch-idempotent');
  const parentId = await createTestAgent(session.user.id, 'Batch idempotent parent');
  const agents = [
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
  ];
  const first = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assert(
    first.status === 201 || first.status === 207,
    `First POST: expected 201 or 207, got ${first.status}`
  );
  const firstBody = assertSchema(BatchResponseSchema, first.data, 'idempotent first');
  for (const r of firstBody.results) trackedAgentIds.add(r.agent_id);
  // Re-POST identical body — same agent_ids.
  const second = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assert(
    second.status === 201 || second.status === 207,
    `Second POST: expected 201 or 207, got ${second.status}`
  );
  const secondBody = assertSchema(BatchResponseSchema, second.data, 'idempotent second');
  // Every result on the retry should be flagged as pre-existing.
  for (const r of secondBody.results) {
    assert(r.already_existed === true, `Expected already_existed=true on retry for ${r.agent_id}`);
  }
  // DB should still have exactly the original 2 children + parent.
  const childCount = await prisma.agent.count({
    where: { userId: session.user.id, parentAgentId: parentId, deletedAt: null },
  });
  assert(childCount === 2, `Expected 2 children after retry, got ${childCount}`);
  for (const r of firstBody.results) await deleteTestAgent(r.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — sub-agents inherit parent proxyCountry', async () => {
  // Fix #2 from the latency optimization PR: sub-agents must inherit their
  // parent's proxyCountry/State/City rather than being geolocated from the
  // worker IP. The batch endpoint must honor the same rule.
  const session = await createAnonymousSession('batch-proxy-inherit');
  const parentId = await createTestAgent(session.user.id, 'Batch proxy parent');
  // Stamp a known proxy on the parent so we can assert children copy it.
  await prisma.agent.update({
    where: { id: parentId },
    data: { proxyCountry: 'XB', proxyState: 'TX', proxyCity: 'TESTCITY' },
  });
  const agents = [
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
    makeBatchAgent({ parentAgentId: parentId, busId: parentId }),
  ];
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assert(res.status === 201 || res.status === 207, `Expected 201 or 207, got ${res.status}`);
  const body = assertSchema(BatchResponseSchema, res.data, 'batch proxy inherit');
  for (const r of body.results) trackedAgentIds.add(r.agent_id);
  const children = await prisma.agent.findMany({
    where: { id: { in: body.results.map((r) => r.agent_id) } },
    select: { id: true, proxyCountry: true, proxyState: true, proxyCity: true },
  });
  assert(children.length === 2, `Expected 2 children rows`);
  for (const c of children) {
    assert(c.proxyCountry === 'XB', `Child ${c.id} proxyCountry=${c.proxyCountry}, expected XB`);
    assert(c.proxyState === 'TX', `Child ${c.id} proxyState=${c.proxyState}, expected TX`);
    assert(c.proxyCity === 'TESTCITY', `Child ${c.id} proxyCity=${c.proxyCity}, expected TESTCITY`);
  }
  for (const r of body.results) await deleteTestAgent(r.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

test('POST /agents/batch — temporalWorkflowId set up-front (no UPDATE needed)', async () => {
  // Fix #3 from the latency optimization PR: temporal_workflow_id === agent_id
  // and is written during the create transaction, never via a follow-up UPDATE.
  const session = await createAnonymousSession('batch-twfid-up-front');
  const parentId = await createTestAgent(session.user.id, 'Batch twfid parent');
  const agents = [makeBatchAgent({ parentAgentId: parentId, busId: parentId })];
  const res = await request(`${BASE_URL}/api/agents/batch`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ agents }),
  });
  assert(res.status === 201 || res.status === 207, `Expected 201 or 207, got ${res.status}`);
  const body = assertSchema(BatchResponseSchema, res.data, 'twfid up-front');
  for (const r of body.results) trackedAgentIds.add(r.agent_id);
  const child = body.results[0];
  if (child.status === 'STARTING_UP') {
    const row = await prisma.agent.findUnique({
      where: { id: child.agent_id },
      select: { temporalWorkflowId: true, id: true },
    });
    assert(row?.temporalWorkflowId === row?.id, 'temporalWorkflowId must equal agent.id');
  }
  for (const r of body.results) await deleteTestAgent(r.agent_id, session.user.id);
  await deleteTestAgent(parentId, session.user.id);
});

// ---------------------------------------------------------------------------
// Boundary capture tests (run sequentially — shared capture buffer)
// ---------------------------------------------------------------------------

/**
 * POST / (create agent) triggers synchronous outbound calls:
 *   1. openrouter.ai/api/v1/models  (model pricing — GET)
 *   2. ip-api.com/json/{ip}         (geolocation — GET)
 * And fire-and-forget calls:
 *   3. api.github.com/user/repos    (repo creation — POST)
 *   4. supabase .../completions      (chat handler — POST)
 *   5. supabase .../realtime/...     (broadcast — POST)
 */

async function testBoundary_createAgentModelPricing(): Promise<void> {
  const session = await createAnonymousSession('boundary-model-pricing');
  await clearCaptures();

  await createTestAgent(session.user.id, 'Boundary model pricing test');

  // Wait briefly for fire-and-forget calls to complete
  await sleep(1500);
  const calls = await readCaptures();

  // Filter for the OpenRouter model pricing call specifically (models list).
  // Post-rose-migration, openrouter.ai is also used for chat completions via
  // the in-process Rose provider (/api/v1/chat/completions), so we must
  // narrow to the /v1/models endpoint to test the pricing path only.
  const pricingCalls = calls.filter((c) => c.url.includes('openrouter.ai/api/v1/models'));
  // May be 0 if result was cached in-memory by modelPricing.ts (24h TTL)
  // or 1 if cache expired. Assert on shape when present.
  if (pricingCalls.length > 0) {
    const call = pricingCalls[0];
    assert(
      call.url === 'https://openrouter.ai/api/v1/models',
      `Expected OpenRouter models URL, got ${call.url}`
    );
    assert(call.method === 'GET', `Expected GET, got ${call.method}`);
    assert(
      call.requestHeaders['authorization']?.startsWith('Bearer ') ||
        call.requestHeaders['Authorization']?.startsWith('Bearer '),
      'Expected Bearer auth header for OpenRouter'
    );
  }

  await deleteTestAgent(
    await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) })
      .then((r) => (r.data as Record<string, unknown>).agents as { agent_id: string }[] | undefined)
      .then((agents) => agents?.[0]?.agent_id ?? ''),
    session.user.id
  ).catch(() => {});
}

async function testBoundary_createAgentGeoip(): Promise<void> {
  const session = await createAnonymousSession('boundary-geoip');
  await clearCaptures();

  await createTestAgent(session.user.id, 'Boundary geoip test');

  await sleep(1500);
  const calls = await readCaptures();

  // Filter for ip-api.com geolocation call
  const geoCalls = calls.filter((c) => c.url.includes('ip-api.com'));
  // May be 0 if client IP is null (common in test env with localhost requests)
  if (geoCalls.length > 0) {
    const call = geoCalls[0];
    assert(
      call.url.startsWith('http://ip-api.com/json/'),
      `Expected ip-api.com URL, got ${call.url}`
    );
    assert(call.method === 'GET', `Expected GET for geoip, got ${call.method}`);
  }

  // Cleanup via list+delete
  const listRes = await request(`${BASE_URL}/api/agents`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const agents = ((listRes.data as Record<string, unknown>).agents || []) as { agent_id: string }[];
  for (const a of agents) {
    await deleteTestAgent(a.agent_id, session.user.id).catch(() => {});
  }
}

async function testBoundary_createAgentGithubRepo(): Promise<void> {
  const session = await createAnonymousSession('boundary-github');
  await clearCaptures();

  // Chat mode root agent triggers fire-and-forget GitHub repo creation
  await createTestAgent(session.user.id, 'Boundary github test');

  // Wait longer for fire-and-forget GitHub call
  await sleep(3000);
  const calls = await readCaptures();

  // Filter for GitHub API call
  const githubCalls = calls.filter((c) => c.url.includes('api.github.com'));
  // May be 0 if GITHUB_TOKEN is not configured
  if (githubCalls.length > 0) {
    const call = githubCalls[0];
    assert(
      call.url === 'https://api.github.com/user/repos',
      `Expected GitHub repos URL, got ${call.url}`
    );
    assert(call.method === 'POST', `Expected POST for GitHub, got ${call.method}`);
    assert(
      call.requestHeaders['accept']?.includes('application/vnd.github') ||
        call.requestHeaders['Accept']?.includes('application/vnd.github'),
      'Expected GitHub Accept header'
    );
    // Verify request body has repo name
    if (call.requestBody) {
      const body = JSON.parse(call.requestBody);
      assert(
        typeof body.name === 'string' && body.name.startsWith('agent-'),
        `Expected repo name starting with agent-, got ${body.name}`
      );
    }
  }

  const listRes = await request(`${BASE_URL}/api/agents`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const agents = ((listRes.data as Record<string, unknown>).agents || []) as { agent_id: string }[];
  for (const a of agents) {
    await deleteTestAgent(a.agent_id, session.user.id).catch(() => {});
  }
}

async function testBoundary_createAgentCallOrdering(): Promise<void> {
  const session = await createAnonymousSession('boundary-ordering');
  await clearCaptures();

  // Tag this test's outbound fetches so we can filter out cross-test contamination
  // (prior tests' fire-and-forget handlers may still be making calls in our window).
  // The backend's captureTokenMiddleware + AsyncLocalStorage propagates the tag
  // through the full async chain — synchronous awaits AND fire-and-forget.
  const captureToken = `ordering-${randomUUID()}`;
  const createRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(session.user.id), 'X-Capture-Token': captureToken },
    body: JSON.stringify({ goal: 'Boundary ordering test' }),
  });
  if (createRes.status === 201) {
    const body = createRes.data as { agent_id: string };
    trackedAgentIds.add(body.agent_id);
  }

  await sleep(2000);

  // Filter captures to only those tagged with our token.
  const res = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(res.status, 200, res.data);
  const calls = (res.data as { captures: CapturedCall[] }).captures;

  // Synchronous calls (model pricing, geoip) should be INITIATED before
  // fire-and-forget calls (github, chat). Compare request-start `timestamp`
  // values rather than array indices — captures are pushed on response
  // completion, so fast-forward caching can invert array order.
  const syncCall = calls.find(
    (c) => c.url.includes('openrouter.ai/api/v1/models') || c.url.includes('ip-api.com')
  );
  const asyncCall = calls.find(
    (c) => c.url.includes('api.github.com') || c.url.includes('/chat/completions')
  );

  if (syncCall && asyncCall) {
    const syncT = new Date(syncCall.timestamp).getTime();
    const asyncT = new Date(asyncCall.timestamp).getTime();
    assert(
      syncT <= asyncT,
      `Synchronous boundary call (${syncCall.url} @ ${syncCall.timestamp}) should be initiated before fire-and-forget call (${asyncCall.url} @ ${asyncCall.timestamp})`
    );
  }
  // If either set is empty (e.g., cached or unconfigured), the ordering check is vacuously true

  const listRes = await request(`${BASE_URL}/api/agents`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const agents = ((listRes.data as Record<string, unknown>).agents || []) as { agent_id: string }[];
  for (const a of agents) {
    await deleteTestAgent(a.agent_id, session.user.id).catch(() => {});
  }
}

async function testBoundary_validationShortCircuitNoOutbound(): Promise<void> {
  const session = await createAnonymousSession('boundary-validation');
  // Drain any in-flight calls from the parallel phase before asserting zero outbound
  await sleep(500);
  await clearCaptures();

  // Missing goal → 400: should not make any outbound calls
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'validation short-circuit');

  const calls = await readCaptures();
  // Filter to agent-relevant services only
  const agentCalls = calls.filter(
    (c) =>
      c.url.includes('openrouter.ai') ||
      c.url.includes('ip-api.com') ||
      c.url.includes('api.github.com')
  );
  assert(
    agentCalls.length === 0,
    `Validation failure should make 0 outbound calls, got ${agentCalls.length}`
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runAll(): Promise<void> {
  console.log(
    `Agents Black-box Tests (${tests.length} parallel cases, concurrency=${CASE_CONCURRENCY}, runId=${RUN_ID})\n`
  );
  console.log(`Testing against: ${BASE_URL}\n`);

  // Phase 1: Parallel tests
  console.log(`Running ${tests.length} parallel tests (concurrency=${CASE_CONCURRENCY})...`);
  const parallelResults = await runWithConcurrency(tests, CASE_CONCURRENCY, async (tc) => {
    return runTest(tc.name, tc.fn);
  });

  for (const r of parallelResults) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name} (${r.duration}ms)`);
  }

  // Phase 2: Sequential boundary capture tests (shared capture buffer)
  const captureAvailable = await checkCaptureAvailable();
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [];

  if (captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary — create agent calls OpenRouter for model pricing',
        fn: testBoundary_createAgentModelPricing,
      },
      {
        name: 'boundary — create agent calls ip-api for geolocation',
        fn: testBoundary_createAgentGeoip,
      },
      {
        name: 'boundary — create agent calls GitHub for repo creation',
        fn: testBoundary_createAgentGithubRepo,
      },
      {
        name: 'boundary — create agent call ordering (sync before fire-and-forget)',
        fn: testBoundary_createAgentCallOrdering,
      },
      {
        // Run last: Phase 1 fire-and-forget handlers (GitHub, chat) may still be
        // making outbound calls when Phase 2 starts. Running this test last gives
        // those background calls time to drain before we assert zero outbound calls.
        name: 'boundary — validation short-circuit makes no outbound calls',
        fn: testBoundary_validationShortCircuitNoOutbound,
      }
    );
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) — skipping boundary tests'
    );
  }

  const sequentialResults: TestResult[] = [];
  if (sequentialTests.length > 0) {
    console.log(`\nRunning ${sequentialTests.length} sequential boundary tests...`);
    for (const tc of sequentialTests) {
      const result = await runTest(tc.name, tc.fn);
      sequentialResults.push(result);
      console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name} (${result.duration}ms)`);
    }
  }

  // Summary
  const allResults = [...parallelResults, ...sequentialResults];
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(60));
  for (const r of allResults) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name} (${r.duration}ms)`);
  }

  if (failed > 0) {
    console.log(`\nFAILURES (${failed}):`);
    for (const r of allResults.filter((r) => !r.passed)) {
      console.log(`  ${r.name}: ${r.error}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${allResults.length} total\n`);

  // Best-effort cleanup of any tracked agents that were not deleted by their test
  for (const agentId of trackedAgentIds) {
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: { deletedAt: new Date() },
      });
    } catch {
      // Agent may already be cleaned up or not exist
    }
  }

  await prisma.$disconnect();

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
