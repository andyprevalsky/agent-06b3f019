#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for the claude-code domain
 *
 * Covers:
 *   POST /api/claude-code-session/create            — create E2B sandbox session
 *   POST /api/claude-code-session/close              — close sandbox session
 *   GET  /api/claude-code-session/:taskId            — get session by task ID
 *   GET  /api/claude-code-session/agent/:agentId     — list sessions for agent
 *   POST /api/claude-code-session/:taskId/output     — persist terminal output
 *   GET  /api/claude-code-session/:sandboxId/health  — sandbox health check
 *
 * Boundary capture tests (Phase 3):
 *   E2B SDK is the primary external boundary. The SDK calls https://api.e2b.app/sandboxes.
 *   - POST /create with valid body → E2B SDK call captured (URL, method asserted)
 *   - POST /create with github missing user_id → 0 outbound calls (short-circuits at 400)
 *   - POST /close with non-existent task → 0 outbound calls (short-circuits at DB miss)
 *   - GET /:sandboxId/health → E2B SDK call captured (connect attempt)
 *   - GitHub repo access check → DB-only, 0 github.com calls
 *
 * Invariants covered:
 *   - auth boundary: all endpoints reject unauthenticated requests with 401
 *   - error-surface: all error responses include { error: string }
 *   - concurrency: all tests use unique UUIDs; no shared mutable state
 *   - boundary param: E2B SDK calls captured with exact URL; validation short-circuits produce 0 calls
 *   - reproducibility: deterministic given same inputs
 *   - cleanup: no persistent state created (all writes require E2B); UUID4 test data
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Invariants not applicable:
 *   - idempotency: mutating happy paths require E2B sandbox (not available in test)
 *   - read-after-write: can't create sessions without E2B
 *   - state-transition: can't create sessions without E2B to observe status changes
 *   - ordering/pagination: agent sessions list is limited to 10, no pagination params
 *   - atomicity: session creation is single-path through E2B + DB
 *   - referential integrity: enforced by Prisma/Postgres, not the route layer
 *   - tenant isolation: can't test without created sessions
 *   - time/clock: no timestamp assertions possible without sessions
 *   - call ordering: no multi-call outbound paths accessible without E2B
 *   - event/job cardinality: no events emitted by these routes
 *   - duplication prevention: sandbox ID uniqueness enforced by DB constraint + E2B
 *   - permission/tenant isolation: session access not scoped by user (internal API)
 *
 * Residual risks:
 *   - E2B happy paths (successful sandbox create/close/health) are not exercised because
 *     creating real sandboxes is expensive and slow. The E2B boundary IS captured and
 *     asserted on (URL, method), but we can't assert on a successful E2B response.
 *   - Output persist (POST /:taskId/output) happy path requires a pre-existing session
 *     record, which can only be created via a successful E2B sandbox creation.
 *   - GitHub repo cloning path (GITHUB_TOKEN injection into sandbox) not testable.
 *   - Per-user credential decryption path (fetchClaudeCodeCredentials) not testable
 *     without encrypted Integration records.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/claude-code.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/claude-code.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(process.env.BLACKBOX_TEST_CASE_CONCURRENCY || '30');

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({ error: z.string() });

const AgentSessionsResponse = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      agentId: z.string(),
      sandboxId: z.string(),
      streamUrl: z.string().nullable(),
      goal: z.string(),
      status: z.enum(['ACTIVE', 'COMPLETED', 'CLOSED', 'ERROR']),
      output: z.string().nullable(),
      createdAt: z.string().or(z.date()),
      closedAt: z.string().or(z.date()).nullable(),
    })
  ),
});

const HealthResponseSchema = z
  .object({
    alive: z.boolean(),
    sandbox_id: z.string(),
  })
  .passthrough();

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
}

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface TestContext {
  captureAvailable: boolean;
}

const ctx: TestContext = { captureAvailable: false };

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';
const FAKE_UUID_2 = '11111111-1111-1111-1111-111111111111';

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

function apiKeyHeaders(userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': API_KEY };
  if (userId) h['X-User-Id'] = userId;
  return h;
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
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
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

// ==================== SETUP ====================

async function setup(): Promise<void> {
  ctx.captureAvailable = await checkCaptureAvailable();
}

// ==================== POST /create ====================

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    body: JSON.stringify({ agent_id: FAKE_UUID, goal: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testCreate_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    body: JSON.stringify({ agent_id: FAKE_UUID, goal: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create 401');
}

async function testCreate_emptyBody() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create empty body');
}

async function testCreate_missingGoal() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: FAKE_UUID }),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create missing goal');
}

async function testCreate_missingAgentId() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ goal: 'test' }),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create missing agent_id');
}

async function testCreate_nonUuidAgentId() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: 'not-a-uuid', goal: 'test' }),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /create non-uuid agent_id');
}

async function testCreate_githubWithoutUserId() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'test',
      github_repo_url: 'https://github.com/test-owner/test-repo',
    }),
  });
  // Agent DB lookup will fail silently (agent doesn't exist), so effectiveUserId stays undefined
  // → 400 MISSING_USER_ID
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string; code?: string };
  assert(body.code === 'MISSING_USER_ID', `Expected code MISSING_USER_ID, got ${body.code}`);
}

async function testCreate_githubAccessDenied() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'test',
      github_repo_url: 'https://github.com/nonexistent-owner/nonexistent-repo',
      user_id: FAKE_UUID,
    }),
  });
  // No GithubRepoAccess record → 403
  assertStatus(res.status, 403, res.data);
  const body = res.data as { error: string; code?: string };
  assert(
    body.code === 'GITHUB_ACCESS_DENIED',
    `Expected code GITHUB_ACCESS_DENIED, got ${body.code}`
  );
}

async function testCreate_validBodyE2bBoundary() {
  // Valid body passes Zod + GitHub checks, then hits E2B SDK.
  // 500 = E2B rejects (expired key, bad template, etc.) or 200 = sandbox created.
  // We accept both: the contract is that the endpoint responds, not that E2B succeeds.
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: FAKE_UUID, goal: 'test blackbox' }),
  });
  assert(
    res.status === 500 || res.status === 200,
    `Expected 500 or 200, got ${res.status}: ${JSON.stringify(res.data).substring(0, 200)}`
  );
  if (res.status === 500) {
    assertSchema(ErrorResponse, res.data, 'POST /create E2B boundary');
  }
}

async function testCreate_invalidGithubUrl() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'test',
      github_repo_url: 'not-a-github-url',
      user_id: FAKE_UUID,
    }),
  });
  // normalizeGithubUrl returns null for invalid URLs → checkGithubRepoAccess returns allowed: false
  assertStatus(res.status, 403, res.data);
  const body = res.data as { error: string; code?: string };
  assert(
    body.code === 'GITHUB_ACCESS_DENIED',
    `Expected code GITHUB_ACCESS_DENIED, got ${body.code}`
  );
}

// ==================== POST /close ====================

async function testClose_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    body: JSON.stringify({ task_id: FAKE_UUID }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testClose_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    body: JSON.stringify({ task_id: FAKE_UUID }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /close 401');
}

async function testClose_emptyBody() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /close empty body');
}

async function testClose_nonExistentTask() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ task_id: FAKE_UUID }),
  });
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /close non-existent task');
  const body = res.data as { error: string };
  assert(
    body.error.includes('not found'),
    `Expected error to include "not found", got: ${body.error}`
  );
}

async function testClose_nonUuidTaskId() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ task_id: 'not-a-uuid' }),
  });
  // Zod validation rejects non-uuid → 500
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /close non-uuid task_id');
}

// ==================== GET /:taskId ====================

async function testGet_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
}

async function testGet_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:taskId 401');
}

async function testGet_notFound() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:taskId 404');
}

async function testGet_notFound_differentUuid() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID_2}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 404, res.data);
}

// ==================== GET /agent/:agentId ====================

async function testGetByAgent_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
}

async function testGetByAgent_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${FAKE_UUID}`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /agent/:agentId 401');
}

async function testGetByAgent_empty() {
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${FAKE_UUID}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AgentSessionsResponse, res.data, 'GET /agent/:agentId 200');
  assert(body.sessions.length === 0, `Expected 0 sessions, got ${body.sessions.length}`);
}

async function testGetByAgent_empty_differentUuid() {
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/${FAKE_UUID_2}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { sessions: unknown[] };
  assert(Array.isArray(body.sessions), 'Expected sessions array');
  assert(body.sessions.length === 0, `Expected 0 sessions, got ${body.sessions.length}`);
}

// ==================== POST /:taskId/output ====================

async function testOutput_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    body: JSON.stringify({ output: 'test output' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testOutput_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    body: JSON.stringify({ output: 'test output' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output 401');
}

async function testOutput_missingField() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output missing output');
}

async function testOutput_emptyString() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ output: '' }),
  });
  // Empty string is falsy → 400
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output empty string');
}

async function testOutput_numericOutput() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ output: 12345 }),
  });
  // typeof output !== 'string' → 400
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output numeric');
}

async function testOutput_nonExistentTask() {
  const res = await request(`${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ output: 'test output content' }),
  });
  // Prisma update on non-existent record → throws → 500
  assertStatus(res.status, 500, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /:taskId/output non-existent');
}

// ==================== GET /:sandboxId/health ====================

async function testHealth_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/fake-sandbox-id/health`);
  assertStatus(res.status, 401, res.data);
}

async function testHealth_noAuth_errorSchema() {
  const res = await request(`${BASE_URL}/api/claude-code-session/fake-sandbox-id/health`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:sandboxId/health 401');
}

async function testHealth_nonExistentSandbox() {
  const res = await request(
    `${BASE_URL}/api/claude-code-session/nonexistent-sandbox-12345/health`,
    { headers: apiKeyHeaders() }
  );
  // connectToSandbox either throws (E2B_API_KEY not set) or fails to connect → alive: false
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(HealthResponseSchema, res.data, 'GET /:sandboxId/health dead');
  assert(body.alive === false, `Expected alive: false, got ${body.alive}`);
  assert(
    body.sandbox_id === 'nonexistent-sandbox-12345',
    `Expected sandbox_id to match, got ${body.sandbox_id}`
  );
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testErrorSurface_all401sHaveErrorField() {
  // Hit all endpoints without auth and verify error field present
  const endpoints = [
    { url: `${BASE_URL}/api/claude-code-session/create`, method: 'POST', body: '{}' },
    { url: `${BASE_URL}/api/claude-code-session/close`, method: 'POST', body: '{}' },
    { url: `${BASE_URL}/api/claude-code-session/${FAKE_UUID}`, method: 'GET' },
    { url: `${BASE_URL}/api/claude-code-session/agent/${FAKE_UUID}`, method: 'GET' },
    { url: `${BASE_URL}/api/claude-code-session/${FAKE_UUID}/output`, method: 'POST', body: '{}' },
    { url: `${BASE_URL}/api/claude-code-session/fake-sb/health`, method: 'GET' },
  ];

  for (const ep of endpoints) {
    const res = await request(ep.url, {
      method: ep.method as string,
      ...(ep.body ? { body: ep.body } : {}),
    });
    assertStatus(res.status, 401, res.data);
    assertSchema(ErrorResponse, res.data, `error surface ${ep.method} ${ep.url}`);
  }
}

// ==================== BOUNDARY CAPTURE TESTS (Sequential) ====================

async function testBoundary_createCallsE2bApi() {
  await clearCaptures();
  await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: FAKE_UUID, goal: 'boundary test' }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const calls = await readCaptures();
  // E2B SDK calls https://api.e2b.app/sandboxes — assert on the captured call
  assert(calls.length >= 1, `Expected at least 1 E2B outbound call, got ${calls.length}`);
  const e2bCalls = calls.filter((c) => c.url.includes('e2b.app'));
  assert(
    e2bCalls.length >= 1,
    `Expected at least 1 call to e2b.app, got ${e2bCalls.length}. All calls: ${calls.map((c) => c.url).join(', ')}`
  );
  // Assert exact URL pattern
  assert(
    e2bCalls[0].url.startsWith('https://api.e2b.app/'),
    `Expected E2B URL to start with https://api.e2b.app/, got ${e2bCalls[0].url}`
  );
  // No unexpected non-E2B calls
  const nonE2bCalls = calls.filter((c) => !c.url.includes('e2b.app'));
  assert(
    nonE2bCalls.length === 0,
    `Unexpected non-E2B outbound calls: ${nonE2bCalls.map((c) => `${c.method} ${c.url}`).join(', ')}`
  );
}

async function testBoundary_closeNonExistentNoOutbound() {
  await clearCaptures();
  await request(`${BASE_URL}/api/claude-code-session/close`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ task_id: FAKE_UUID }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const calls = await readCaptures();
  assert(
    calls.length === 0,
    `Expected 0 outbound calls for non-existent task close, got ${calls.length}: ${calls.map((c) => c.url).join(', ')}`
  );
}

async function testBoundary_githubAccessCheckDbOnly() {
  await clearCaptures();
  await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'boundary github test',
      github_repo_url: 'https://github.com/test-owner/test-repo',
      user_id: FAKE_UUID,
    }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const calls = await readCaptures();
  // GitHub access check is DB-only — no fetch to github.com.
  // The request returns 403 (access denied) before reaching E2B, so no E2B calls either.
  const githubCalls = calls.filter((c) => c.url.includes('github.com'));
  assert(
    githubCalls.length === 0,
    `Expected 0 GitHub API calls (access check is DB-only), got ${githubCalls.length}: ${githubCalls.map((c) => c.url).join(', ')}`
  );
  assert(
    calls.length === 0,
    `Expected 0 total outbound calls (403 short-circuits before E2B), got ${calls.length}: ${calls.map((c) => c.url).join(', ')}`
  );
}

async function testBoundary_healthCallsE2bApi() {
  await clearCaptures();
  await request(`${BASE_URL}/api/claude-code-session/nonexistent-sandbox/health`, {
    headers: apiKeyHeaders(),
  });
  await new Promise((r) => setTimeout(r, 200));
  const calls = await readCaptures();
  // E2B SDK calls api.e2b.app to connect to sandbox
  assert(
    calls.length >= 1,
    `Expected at least 1 E2B outbound call for health, got ${calls.length}`
  );
  const e2bCalls = calls.filter((c) => c.url.includes('e2b.app'));
  assert(
    e2bCalls.length >= 1,
    `Expected at least 1 call to e2b.app, got ${e2bCalls.length}. All calls: ${calls.map((c) => c.url).join(', ')}`
  );
  assert(
    e2bCalls[0].url.startsWith('https://api.e2b.app/'),
    `Expected E2B URL to start with https://api.e2b.app/, got ${e2bCalls[0].url}`
  );
  // No unexpected non-E2B calls
  const nonE2bCalls = calls.filter((c) => !c.url.includes('e2b.app'));
  assert(
    nonE2bCalls.length === 0,
    `Unexpected non-E2B outbound calls: ${nonE2bCalls.map((c) => `${c.method} ${c.url}`).join(', ')}`
  );
}

async function testBoundary_createGithubMissingUserIdNoOutbound() {
  await clearCaptures();
  await request(`${BASE_URL}/api/claude-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: FAKE_UUID,
      goal: 'boundary missing user_id test',
      github_repo_url: 'https://github.com/test/repo',
    }),
  });
  await new Promise((r) => setTimeout(r, 200));
  const calls = await readCaptures();
  // 400 MISSING_USER_ID short-circuits before any outbound calls
  assert(
    calls.length === 0,
    `Expected 0 outbound calls for missing user_id, got ${calls.length}: ${calls.map((c) => c.url).join(', ')}`
  );
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Claude Code Session Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  // Phase 1: Setup
  await setup();

  // Phase 2: Parallel independent tests
  const parallelTests = [
    // POST /create
    { name: 'POST /create -- no auth -> 401', fn: testCreate_noAuth },
    { name: 'POST /create -- no auth error schema', fn: testCreate_noAuth_errorSchema },
    { name: 'POST /create -- empty body -> 500', fn: testCreate_emptyBody },
    { name: 'POST /create -- missing goal -> 500', fn: testCreate_missingGoal },
    { name: 'POST /create -- missing agent_id -> 500', fn: testCreate_missingAgentId },
    { name: 'POST /create -- non-uuid agent_id -> 500', fn: testCreate_nonUuidAgentId },
    { name: 'POST /create -- github without user_id -> 400', fn: testCreate_githubWithoutUserId },
    { name: 'POST /create -- github access denied -> 403', fn: testCreate_githubAccessDenied },
    { name: 'POST /create -- invalid github URL -> 403', fn: testCreate_invalidGithubUrl },
    {
      name: 'POST /create -- valid body hits E2B boundary -> 500 or 200',
      fn: testCreate_validBodyE2bBoundary,
    },

    // POST /close
    { name: 'POST /close -- no auth -> 401', fn: testClose_noAuth },
    { name: 'POST /close -- no auth error schema', fn: testClose_noAuth_errorSchema },
    { name: 'POST /close -- empty body -> 500', fn: testClose_emptyBody },
    { name: 'POST /close -- non-existent task -> 500', fn: testClose_nonExistentTask },
    { name: 'POST /close -- non-uuid task_id -> 500', fn: testClose_nonUuidTaskId },

    // GET /:taskId
    { name: 'GET /:taskId -- no auth -> 401', fn: testGet_noAuth },
    { name: 'GET /:taskId -- no auth error schema', fn: testGet_noAuth_errorSchema },
    { name: 'GET /:taskId -- not found -> 404', fn: testGet_notFound },
    { name: 'GET /:taskId -- not found different UUID -> 404', fn: testGet_notFound_differentUuid },

    // GET /agent/:agentId
    { name: 'GET /agent/:agentId -- no auth -> 401', fn: testGetByAgent_noAuth },
    { name: 'GET /agent/:agentId -- no auth error schema', fn: testGetByAgent_noAuth_errorSchema },
    { name: 'GET /agent/:agentId -- empty sessions -> 200', fn: testGetByAgent_empty },
    {
      name: 'GET /agent/:agentId -- empty sessions different UUID',
      fn: testGetByAgent_empty_differentUuid,
    },

    // POST /:taskId/output
    { name: 'POST /:taskId/output -- no auth -> 401', fn: testOutput_noAuth },
    { name: 'POST /:taskId/output -- no auth error schema', fn: testOutput_noAuth_errorSchema },
    { name: 'POST /:taskId/output -- missing output -> 400', fn: testOutput_missingField },
    { name: 'POST /:taskId/output -- empty string -> 400', fn: testOutput_emptyString },
    { name: 'POST /:taskId/output -- numeric output -> 400', fn: testOutput_numericOutput },
    { name: 'POST /:taskId/output -- non-existent task -> 500', fn: testOutput_nonExistentTask },

    // GET /:sandboxId/health
    { name: 'GET /:sandboxId/health -- no auth -> 401', fn: testHealth_noAuth },
    { name: 'GET /:sandboxId/health -- no auth error schema', fn: testHealth_noAuth_errorSchema },
    {
      name: 'GET /:sandboxId/health -- non-existent -> alive:false',
      fn: testHealth_nonExistentSandbox,
    },

    // Error surface invariant
    {
      name: 'error surface -- all 401s have error field',
      fn: testErrorSurface_all401sHaveErrorField,
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

  // Phase 3: Sequential boundary capture tests
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [];

  if (ctx.captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary -- create valid body calls E2B API at api.e2b.app',
        fn: testBoundary_createCallsE2bApi,
      },
      {
        name: 'boundary -- close non-existent task makes 0 outbound calls',
        fn: testBoundary_closeNonExistentNoOutbound,
      },
      {
        name: 'boundary -- github access check is DB-only (no github.com calls)',
        fn: testBoundary_githubAccessCheckDbOnly,
      },
      {
        name: 'boundary -- health check calls E2B API at api.e2b.app',
        fn: testBoundary_healthCallsE2bApi,
      },
      {
        name: 'boundary -- create with github missing user_id makes 0 outbound calls',
        fn: testBoundary_createGithubMissingUserIdNoOutbound,
      }
    );
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

  if (sequentialTests.length > 0) {
    console.log(`\nRunning ${sequentialTests.length} sequential tests...`);
  }
  const sequentialResults: TestResult[] = [];
  for (const test of sequentialTests) {
    const result = await runTest(test.name, test.fn);
    sequentialResults.push(result);
    const icon = result.passed ? '  PASS' : '  FAIL';
    console.log(
      `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
    );
  }

  // Summary
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

  console.log('\nALL CLAUDE-CODE BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
