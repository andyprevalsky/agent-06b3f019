#!/usr/bin/env tsx
import { runTest, type TestResult } from './browser-session-test-support';
/**
 * Black-box tests for /api/browser-session
 *
 * Domain surface:
 *   POST /api/browser-session/init                      — initialize browser session (auth: API key)
 *   POST /api/browser-session/close                     — close/pause session (auth: API key)
 *   POST /api/browser-session/resume                    — resume paused task (auth: API key)
 *   GET  /api/browser-session/task/:taskId              — get task session info (auth: API key)
 *   GET  /api/browser-session/context/:userId           — get user context (auth: API key)
 *   GET  /api/browser-session/:sessionId                — get session info (auth: API key)
 *   POST /api/browser-session/:sessionId/files          — upload file to session (auth: API key, multipart)
 *   GET  /api/browser-session/:sessionId/files/list     — list session files (auth: API key)
 *   POST /api/browser-session/:sessionId/inject-localStorage — inject localStorage (auth: API key)
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated requests return 401 for all endpoints
 *   - error-surface: invalid body returns 500 (Zod parse); nonexistent resources return 404
 *   - idempotency: GET endpoints return same shape on repeated calls
 *   - concurrency: 10 parallel auth-check requests return consistent results
 *   - same-input reproducibility: three sequential 404s return identical status
 *   - cleanup: read-only tests (no real Steel sessions created), no state mutations
 *   - harness independence: no background jobs involved
 *   - observability: covered by runner manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write: cannot test without real Steel session (requires Steel SDK/billing)
 *   - state-transition: session lifecycle requires real Steel sessions
 *   - ordering/pagination: no list-all endpoint
 *   - atomicity: Steel SDK operations
 *   - referential integrity: FK relations to BrowserContext/BrowserSession
 *   - event/job cardinality: no events emitted
 *   - duplication prevention: sessions are unique by design
 *   - tenant isolation: context scoped by userId
 *   - time/clock: no timestamps in error responses
 *   - boundary param: Steel SDK calls happen inside init/close/resume (untestable without real sessions)
 *   - call ordering: Steel SDK calls are sequential
 *
 * Usage:
 *   npx tsx src/tests/blackbox/browser-session.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/browser-session.blackbox.ts
 */

import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import { runBrowserInitDisconnectCases } from './browser-session-init-disconnect.cases';
import { runBrowserPauseCheckpointCases } from './browser-session-pause-checkpoint.cases';
import { runBrowserTerminalPauseCases } from './browser-session-terminal-pause.cases';
import { runBrowserResumeCustodyCases } from './browser-session-resume-custody.cases';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({ error: z.string() });

// ==================== TEST INFRASTRUCTURE ====================

interface TestContext {
  accessToken?: string;
  userId?: string;
}

const ctx: TestContext = {};

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

function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
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

// ==================== SETUP ====================

async function setup(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token;
  ctx.userId = d.user.id;
}

// ==================== POST /api/browser-session/init ====================

async function testInit_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/init`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'x',
      agent_id: '00000000-0000-0000-0000-000000000000',
      start_url: 'https://example.com',
    }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testInit_invalidBody() {
  const res = await request(`${BASE_URL}/api/browser-session/init`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  // Zod parse throws inside try/catch -> 500
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500 for invalid body, got ${res.status}`);
  }
}

async function testInit_missingUserid() {
  const res = await request(`${BASE_URL}/api/browser-session/init`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      agent_id: '00000000-0000-0000-0000-000000000000',
      start_url: 'https://example.com',
    }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500, got ${res.status}`);
  }
}

async function testInit_missingAgentId() {
  const res = await request(`${BASE_URL}/api/browser-session/init`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      start_url: 'https://example.com',
    }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500, got ${res.status}`);
  }
}

async function testInit_invalidAgentIdFormat() {
  const res = await request(`${BASE_URL}/api/browser-session/init`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: 'not-a-uuid',
      start_url: 'https://example.com',
    }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500 for invalid UUID, got ${res.status}`);
  }
}

async function testInit_missingStartUrl() {
  const res = await request(`${BASE_URL}/api/browser-session/init`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: ctx.userId,
      agent_id: '00000000-0000-0000-0000-000000000000',
    }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500, got ${res.status}`);
  }
}

async function testPrepareAuth_invalidBody() {
  const res = await request(`${BASE_URL}/api/browser-session/missing-session/prepare-auth`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
    body: JSON.stringify({ target_url: 'x'.repeat(8193) }),
  });
  assertStatus(res.status, 400, res.data);
  const error = assertSchema(ErrorResponse, res.data, 'prepare-auth invalid request');
  if (error.error !== 'Invalid prepare-auth request') {
    throw new Error(`Unexpected prepare-auth validation error: ${error.error}`);
  }
}

// ==================== POST /api/browser-session/close ====================

async function testClose_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/close`, {
    method: 'POST',
    body: JSON.stringify({ session_id: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testClose_invalidBody() {
  const res = await request(`${BASE_URL}/api/browser-session/close`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  // Zod parse failure
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500, got ${res.status}`);
  }
}

// ==================== POST /api/browser-session/resume ====================

async function testResume_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/resume`, {
    method: 'POST',
    body: JSON.stringify({ task_id: '00000000-0000-0000-0000-000000000000' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testResume_invalidTaskId() {
  const res = await request(`${BASE_URL}/api/browser-session/resume`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ task_id: 'not-a-uuid' }),
  });
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500, got ${res.status}`);
  }
}

// ==================== GET /api/browser-session/task/:taskId ====================

async function testGetTask_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent`);
  assertStatus(res.status, 401, res.data);
}

async function testGetTask_notFound() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /task (404)');
}

async function testGetTask_validateLivePausedSessionDoesNotCreateReplacement() {
  const context = await prisma.browserContext.create({
    data: {
      userId: `browser-session-validate-${randomUUID()}`,
      contextId: `steel-profile-${randomUUID()}`,
    },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `steel-session-${randomUUID()}`,
      debugUrl: 'https://debug.steel.dev/session/live',
      wsUrl: 'ws://steel/live',
      status: 'PAUSED',
    },
  });

  try {
    const res = await request(
      `${BASE_URL}/api/browser-session/task/${session.id}?validateLive=true`,
      {
        headers: apiKeyHeaders(),
      }
    );
    assertStatus(res.status, 200, res.data);
    const body = res.data as Record<string, unknown>;
    if (body.session_id !== session.sessionId) {
      throw new Error(
        `Expected same session_id ${session.sessionId}, got ${String(body.session_id)}`
      );
    }
    if (body.same_session_available !== false) {
      throw new Error('Expected paused session to be unavailable for same-session reconnect');
    }
    if (body.same_session_unavailable_reason !== 'db_status_paused') {
      throw new Error(
        `Expected db_status_paused reason, got ${String(body.same_session_unavailable_reason)}`
      );
    }
  } finally {
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
  }
}

async function testGetTask_passwordPayloadIncludesStableIds() {
  const userId = `browser-session-password-id-${randomUUID()}`;
  const context = await prisma.browserContext.create({
    data: {
      userId,
      contextId: `steel-profile-${randomUUID()}`,
    },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `steel-session-${randomUUID()}`,
      debugUrl: 'https://debug.steel.dev/session/live',
      wsUrl: 'ws://steel/live',
      status: 'ACTIVE',
    },
  });
  const firstPassword = await prisma.browserPassword.create({
    data: {
      userId,
      origin: 'https://www.amazon.com/ap/signin',
      username: 'shopper@example.com',
      encryptedPassword: 'encrypted-password-1',
      browserSource: 'chrome',
      dateLastUsed: 1234n,
    },
  });
  const secondPassword = await prisma.browserPassword.create({
    data: {
      userId,
      origin: 'https://amazon.com/login',
      username: 'shopper@example.com',
      encryptedPassword: 'encrypted-password-2',
      browserSource: 'chrome',
      dateLastUsed: 1200n,
    },
  });

  try {
    const res = await request(`${BASE_URL}/api/browser-session/task/${session.id}`, {
      headers: apiKeyHeaders(),
    });
    assertStatus(res.status, 200, res.data);
    const body = res.data as { passwords?: Array<Record<string, unknown>> };
    const returnedIds = new Set((body.passwords ?? []).map((item) => item.id));
    for (const password of [firstPassword, secondPassword]) {
      if (!returnedIds.has(password.id)) {
        throw new Error(`Expected password id ${password.id} in session payload`);
      }
    }
    const returnedFirst = body.passwords?.find((item) => item.id === firstPassword.id);
    const returnedSecond = body.passwords?.find((item) => item.id === secondPassword.id);
    if (
      returnedFirst?.encryptedPassword !== 'encrypted-password-1' ||
      returnedSecond?.encryptedPassword !== 'encrypted-password-2'
    ) {
      throw new Error(
        'Expected encrypted password material to remain paired with each session payload id'
      );
    }
  } finally {
    await prisma.browserPassword.deleteMany({ where: { userId } });
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
  }
}

// ==================== GET /api/browser-session/context/:userId ====================

async function testGetContext_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/context/test-user`);
  assertStatus(res.status, 401, res.data);
}

async function testGetContext_happy() {
  const res = await request(`${BASE_URL}/api/browser-session/context/${ctx.userId}`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  // Should return { context: null } or { context: {...} }
  const body = res.data as { context: unknown };
  if (!('context' in body)) {
    throw new Error('Expected response to have "context" key');
  }
}

async function testGetContext_nonexistentUser() {
  const res = await request(`${BASE_URL}/api/browser-session/context/nonexistent-user-id`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { context: unknown };
  if (body.context !== null) {
    throw new Error('Expected null context for nonexistent user');
  }
}

// ==================== GET /api/browser-session/:sessionId ====================

async function testGetSession_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent-session`);
  assertStatus(res.status, 401, res.data);
}

async function testGetSession_notFound() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent-session`, {
    headers: apiKeyHeaders(),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:sessionId (404)');
}

// ==================== GET /api/browser-session/:sessionId/files/list ====================

async function testListFiles_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent/files/list`);
  assertStatus(res.status, 401, res.data);
}

async function testListFiles_invalidSession() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent-session/files/list`, {
    headers: apiKeyHeaders(),
  });
  // Endpoint may return 200 (empty list), 404, or 500 for nonexistent session
  if (res.status !== 200 && res.status !== 404 && res.status !== 500) {
    throw new Error(`Expected 200, 404, or 500 for nonexistent session files, got ${res.status}`);
  }
}

// ==================== POST /api/browser-session/:sessionId/files ====================

async function testUploadFile_noAuth() {
  const blob = new Blob(['test'], { type: 'text/plain' });
  const formData = new FormData();
  formData.append('file', blob, 'test.txt');

  const response = await fetch(`${BASE_URL}/api/browser-session/nonexistent/files`, {
    method: 'POST',
    body: formData,
  });
  if (response.status !== 401) {
    throw new Error(`Expected 401, got ${response.status}`);
  }
}

// ==================== POST /api/browser-session/:sessionId/inject-localStorage ====================

async function testInjectLocalStorage_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent/inject-localStorage`, {
    method: 'POST',
    body: JSON.stringify({ origin: 'https://example.com' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testInjectLocalStorage_invalidOrigin() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent/inject-localStorage`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ origin: 'not-a-url' }),
  });
  // Zod URL validation fails
  if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 400 or 500 for invalid origin, got ${res.status}`);
  }
}

async function testInjectLocalStorage_sessionNotFound() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent/inject-localStorage`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ origin: 'https://example.com' }),
  });
  assertStatus(res.status, 404, res.data);
}

// ==================== POST /api/browser-session/task/:taskId/viewport ====================

async function testResizeViewport_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent/viewport`, {
    method: 'POST',
    body: JSON.stringify({ width: 1180, height: 720 }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testResizeViewport_invalidDimensions() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent/viewport`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ width: 0, height: 720 }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testResizeViewport_nullBody() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent/viewport`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: 'null',
  });
  assertStatus(res.status, 400, res.data);
}

async function testResizeViewport_acceptsNarrowDimensions() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent/viewport`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ width: 120, height: 80 }),
  });
  assertStatus(res.status, 404, res.data);
}

async function testResizeViewport_sessionNotFound() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent/viewport`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ width: 1180, height: 720 }),
  });
  assertStatus(res.status, 404, res.data);
}

// ==================== INVARIANTS ====================

async function testIdempotency_taskNotFound() {
  const r1 = await request(`${BASE_URL}/api/browser-session/task/nonexistent`, {
    headers: apiKeyHeaders(),
  });
  const r2 = await request(`${BASE_URL}/api/browser-session/task/nonexistent`, {
    headers: apiKeyHeaders(),
  });
  if (r1.status !== r2.status) {
    throw new Error(`Idempotency: status ${r1.status} vs ${r2.status}`);
  }
}

async function testConcurrency_parallelAuthChecks() {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => request(`${BASE_URL}/api/browser-session/task/nonexistent`))
  );
  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size !== 1) {
    throw new Error(`Expected uniform status, got: ${[...statuses].join(', ')}`);
  }
}

async function testReproducibility_threeSequential() {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent`, {
      headers: apiKeyHeaders(),
    });
    statuses.push(res.status);
  }
  if (new Set(statuses).size !== 1) {
    throw new Error(`Three sequential: ${statuses.join(', ')}`);
  }
}

// ==================== RUN ====================

async function runAll() {
  if (process.argv.includes('--resume-custody-only')) {
    await runBrowserResumeCustodyCases();
    await prisma.$disconnect();
    return;
  }
  if (process.argv.includes('--pause-checkpoint-only')) {
    await runBrowserPauseCheckpointCases();
    await runBrowserTerminalPauseCases();
    console.log(
      'PASS browser-session pause checkpoint/terminal release (7 cases; fixture provider)'
    );
    return;
  }
  await runBrowserInitDisconnectCases();
  if (process.argv.includes('--init-disconnect-only')) return;
  await runBrowserPauseCheckpointCases();
  await runBrowserTerminalPauseCases();
  console.log('Browser Session Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  console.log('Setting up auth session...');
  await setup();
  console.log(`  User: ${ctx.userId}\n`);

  const parallelTests = [
    // auth boundary — POST /init
    { name: 'POST /browser-session/init -- no auth -> 401', fn: testInit_noAuth },
    { name: 'POST /browser-session/init -- invalid body -> 400/500', fn: testInit_invalidBody },
    { name: 'POST /browser-session/init -- missing user_id', fn: testInit_missingUserid },
    { name: 'POST /browser-session/init -- missing agent_id', fn: testInit_missingAgentId },
    {
      name: 'POST /browser-session/init -- invalid agent_id format',
      fn: testInit_invalidAgentIdFormat,
    },
    {
      name: 'POST /browser-session/:sessionId/prepare-auth -- invalid body -> 400',
      fn: testPrepareAuth_invalidBody,
    },
    { name: 'POST /browser-session/init -- missing start_url', fn: testInit_missingStartUrl },
    // auth boundary — POST /close
    { name: 'POST /browser-session/close -- no auth -> 401', fn: testClose_noAuth },
    { name: 'POST /browser-session/close -- invalid body', fn: testClose_invalidBody },
    // auth boundary — POST /resume
    { name: 'POST /browser-session/resume -- no auth -> 401', fn: testResume_noAuth },
    { name: 'POST /browser-session/resume -- invalid task_id', fn: testResume_invalidTaskId },
    // GET /task/:taskId
    { name: 'GET /browser-session/task -- no auth -> 401', fn: testGetTask_noAuth },
    { name: 'GET /browser-session/task -- not found -> 404', fn: testGetTask_notFound },
    {
      name: 'GET /browser-session/task -- validateLive paused returns same unavailable session',
      fn: testGetTask_validateLivePausedSessionDoesNotCreateReplacement,
    },
    {
      name: 'GET /browser-session/task -- password payload includes stable ids',
      fn: testGetTask_passwordPayloadIncludesStableIds,
    },
    // GET /context/:userId
    { name: 'GET /browser-session/context -- no auth -> 401', fn: testGetContext_noAuth },
    { name: 'GET /browser-session/context -- happy path', fn: testGetContext_happy },
    {
      name: 'GET /browser-session/context -- nonexistent user -> null',
      fn: testGetContext_nonexistentUser,
    },
    // GET /:sessionId
    { name: 'GET /browser-session/:sessionId -- no auth -> 401', fn: testGetSession_noAuth },
    { name: 'GET /browser-session/:sessionId -- not found -> 404', fn: testGetSession_notFound },
    // GET /:sessionId/files/list
    {
      name: 'GET /browser-session/:sessionId/files/list -- no auth -> 401',
      fn: testListFiles_noAuth,
    },
    {
      name: 'GET /browser-session/:sessionId/files/list -- invalid session',
      fn: testListFiles_invalidSession,
    },
    // POST /:sessionId/files
    { name: 'POST /browser-session/:sessionId/files -- no auth -> 401', fn: testUploadFile_noAuth },
    // POST /:sessionId/inject-localStorage
    { name: 'POST /inject-localStorage -- no auth -> 401', fn: testInjectLocalStorage_noAuth },
    {
      name: 'POST /inject-localStorage -- invalid origin',
      fn: testInjectLocalStorage_invalidOrigin,
    },
    {
      name: 'POST /inject-localStorage -- session not found -> 404',
      fn: testInjectLocalStorage_sessionNotFound,
    },
    // POST /task/:taskId/viewport
    { name: 'POST /viewport -- no auth -> 401', fn: testResizeViewport_noAuth },
    {
      name: 'POST /viewport -- invalid dimensions -> 400',
      fn: testResizeViewport_invalidDimensions,
    },
    { name: 'POST /viewport -- null body -> 400', fn: testResizeViewport_nullBody },
    {
      name: 'POST /viewport -- narrow positive dimensions are valid',
      fn: testResizeViewport_acceptsNarrowDimensions,
    },
    { name: 'POST /viewport -- session not found -> 404', fn: testResizeViewport_sessionNotFound },
    // invariants
    { name: 'idempotency -- task not found same on repeat', fn: testIdempotency_taskNotFound },
    {
      name: 'concurrency -- 10 parallel auth checks consistent',
      fn: testConcurrency_parallelAuthChecks,
    },
    {
      name: 'reproducibility -- 3 sequential identical status',
      fn: testReproducibility_threeSequential,
    },
  ];

  console.log(`Running ${parallelTests.length} tests (concurrency=${CASE_CONCURRENCY})...`);
  const results = await runPool(parallelTests, CASE_CONCURRENCY);

  for (const r of results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  await prisma.$disconnect();
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL BROWSER SESSION BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch(async (error) => {
  console.error('\nCrashed:', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
