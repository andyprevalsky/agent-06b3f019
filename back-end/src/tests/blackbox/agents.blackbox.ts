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
    llm_judge_prompt: z.string(),
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
    goal: z.string(),
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

/**
 * Wrapper around `request()` that retries on the transient "Failed to create
 * agent" 500 (e.g., OpenRouter pricing timeout under concurrency).
 * Unlike `createTestAgent`, this returns the full response so callers can
 * assert on body fields beyond `agent_id`.
 */
async function requestWithRetry(
  url: string,
  options: RequestOptions = {},
  maxAttempts = 5
): Promise<{ status: number; data: unknown; headers: Headers }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: { status: number; data: unknown; headers: Headers };
    try {
      res = await request(url, options);
    } catch (err) {
      if (attempt < maxAttempts) {
        console.warn(
          `[retry] requestWithRetry attempt ${attempt}/${maxAttempts} network error: ${err}`
        );
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
    const isRetryable =
      res.status === 500 &&
      typeof res.data === 'object' &&
      res.data !== null &&
      'error' in res.data &&
      (res.data as { error?: unknown }).error === 'Failed to create agent';
    if (isRetryable && attempt < maxAttempts) {
      console.warn(`[retry] requestWithRetry attempt ${attempt}/${maxAttempts} got retryable 500`);
      await sleep(500 * attempt);
      continue;
    }
    return res;
  }
  throw new Error('requestWithRetry exhausted retries');
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
 * Create an agent via API key auth (no Temporal, no chat handler).
 * Uses API key auth which means chatHandler and GitHub repo creation still fire
 * but we don't wait for them. The agent is created in chat mode (no start_phase).
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
  const res = await requestWithRetry(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ goal }),
  });
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
  assert(body.agent.verifier!.llm_judge_prompt.length > 0, 'Verifier prompt should not be empty');

  await deleteTestAgent(agentId, session.user.id);
});

test('POST / — custom verifier preserved', async () => {
  const session = await createAnonymousSession('create-custom-verifier');
  const customPrompt = 'Custom verifier: check if agent wrote tests';
  const res = await requestWithRetry(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({
      goal: 'Custom verifier test',
      verifier: { type: 'FLOAT_LLM_JUDGE', llm_judge_prompt: customPrompt },
    }),
  });
  assertStatus(res.status, 201, res.data);
  const create = assertSchema(CreateAgentResponse, res.data, 'POST / custom verifier');
  trackedAgentIds.add(create.agent_id);

  const detail = await request(`${BASE_URL}/api/agents/${create.agent_id}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const body = assertSchema(GetAgentResponse, detail.data, 'POST / verify custom verifier');
  assert(
    body.agent.verifier?.llm_judge_prompt === customPrompt,
    `Expected custom prompt, got "${body.agent.verifier?.llm_judge_prompt}"`
  );

  await deleteTestAgent(create.agent_id, session.user.id);
});

test('POST / — custom model preserved', async () => {
  const session = await createAnonymousSession('create-model');
  const model = 'rose-labs/rose-1-ultra';
  const res = await requestWithRetry(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ goal: 'Model test', model }),
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

  // Create child agent directly in DB (cannot spawn via API without Temporal)
  const childId = randomUUID();
  trackedAgentIds.add(childId);
  await withTransientDbRetry('create-child-agent', async () => {
    await prisma.agent.create({
      data: {
        id: childId,
        userId: session.user.id,
        goal: 'Child agent',
        parentAgentId: parentId,
        busId: parentId,
      },
    });
    await prisma.verifier.create({
      data: {
        agentId: childId,
        type: 'FLOAT_LLM_JUDGE',
        llmJudgePrompt: 'test',
      },
    });
  });

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

  // Create agent directly in DB to avoid chatHandler race overwriting status
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-raw-status-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'RAW status test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE', llmJudgePrompt: 'test' },
    });
  });

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

  // Create agent directly in DB to avoid chatHandler race overwriting status
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-pause-happy-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Pause test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE', llmJudgePrompt: 'test' },
    });
  });

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

  // Create agent directly in DB as PAUSED to avoid chatHandler race
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-resume-happy-agent', async () => {
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
      data: { agentId, type: 'FLOAT_LLM_JUDGE', llmJudgePrompt: 'test' },
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

  await deleteTestAgent(agentId, session.user.id);
});

test('POST /:id/resume — child with paused parent → 400', async () => {
  const session = await createAnonymousSession('resume-parent-paused');

  // Create parent directly in DB to avoid chatHandler race
  const parentId = randomUUID();
  trackedAgentIds.add(parentId);
  await withTransientDbRetry('create-parent-resume', async () => {
    await prisma.agent.create({
      data: {
        id: parentId,
        userId: session.user.id,
        goal: 'Parent for resume test',
        status: 'PAUSED',
        busId: parentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId: parentId, type: 'FLOAT_LLM_JUDGE', llmJudgePrompt: 'test' },
    });
  });

  // Create child in DB
  const childId = randomUUID();
  trackedAgentIds.add(childId);
  await withTransientDbRetry('create-child-resume', async () => {
    await prisma.agent.create({
      data: {
        id: childId,
        userId: session.user.id,
        goal: 'Child resume test',
        parentAgentId: parentId,
        busId: parentId,
        status: 'PAUSED',
      },
    });
    await prisma.verifier.create({
      data: { agentId: childId, type: 'FLOAT_LLM_JUDGE', llmJudgePrompt: 'test' },
    });
  });

  // Try to resume child while parent is paused → 400
  const res = await request(`${BASE_URL}/api/agents/${childId}/resume`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(res.status, 400, res.data);

  // Cleanup
  await withTransientDbRetry('cleanup-resume', async () => {
    await prisma.agent.updateMany({
      where: { id: { in: [parentId, childId] } },
      data: { deletedAt: new Date() },
    });
  });
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

test('PATCH /:id — update verifier prompt', async () => {
  const session = await createAnonymousSession('upd-verifier');
  const agentId = await createTestAgent(session.user.id, 'Update verifier test');
  const newPrompt = 'Updated verifier: check X instead of Y';

  const res = await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: apiKeyHeaders(session.user.id),
    body: JSON.stringify({ verifier_prompt: newPrompt }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(UpdateAgentResponse, res.data, 'PATCH /:id verifier');
  assert(body.agent.verifier?.llm_judge_prompt === newPrompt, 'Verifier prompt not updated');

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

  // Create agent + post a USER message
  const createRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-User-Id': session.user.id },
    body: JSON.stringify({ goal: 'batch test agent' }),
  });
  assertStatus(createRes.status, 201, createRes.data);
  const agentId = (createRes.data as { agent_id: string }).agent_id;
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

  // Create agent directly in DB to avoid chatHandler race overwriting status
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-round-trip-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'State round-trip test',
        status: 'ACTIVE',
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE', llmJudgePrompt: 'test' },
    });
  });

  // Get initial state
  const before = await request(`${BASE_URL}/api/agents/${agentId}`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const beforeBody = assertSchema(GetAgentResponse, before.data, 'before pause');

  // Pause — assert the mutation response
  const pauseRes = await request(`${BASE_URL}/api/agents/${agentId}/pause`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
  });
  assertStatus(pauseRes.status, 200, pauseRes.data);

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

  // Create agent directly in DB to avoid chatHandler race overwriting status
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry('create-terminal-agent', async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: session.user.id,
        goal: 'Terminal pause test',
        status: 'COMPLETED',
        progress: 1.0,
        busId: agentId,
      },
    });
    await prisma.verifier.create({
      data: { agentId, type: 'FLOAT_LLM_JUDGE', llmJudgePrompt: 'test' },
    });
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

  await withTransientDbRetry('cleanup-terminal', async () => {
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
  });
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

  // Filter for the OpenRouter model pricing call
  const pricingCalls = calls.filter((c) => c.url.includes('openrouter.ai'));
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

  await createTestAgent(session.user.id, 'Boundary ordering test');

  await sleep(2000);
  const calls = await readCaptures();

  // Synchronous calls (model pricing, geoip) should come before fire-and-forget calls (github, chat)
  const syncCallIdx = calls.findIndex(
    (c) => c.url.includes('openrouter.ai') || c.url.includes('ip-api.com')
  );
  const asyncCallIdx = calls.findIndex(
    (c) => c.url.includes('api.github.com') || c.url.includes('completions')
  );

  if (syncCallIdx >= 0 && asyncCallIdx >= 0) {
    assert(
      syncCallIdx < asyncCallIdx,
      `Synchronous boundary calls (idx ${syncCallIdx}) should precede fire-and-forget calls (idx ${asyncCallIdx})`
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
        name: 'boundary — validation short-circuit makes no outbound calls',
        fn: testBoundary_validationShortCircuitNoOutbound,
      },
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
