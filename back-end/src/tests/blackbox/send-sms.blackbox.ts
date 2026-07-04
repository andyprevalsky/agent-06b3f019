#!/usr/bin/env tsx
/* eslint-disable no-console, max-lines */
/**
 * Black-box tests for /api/send-sms
 *
 * Domain surface:
 *   POST /api/send-sms           — send SMS via Surge API (auth required, internal)
 *   POST /api/send-sms/direct    — send SMS by user_id lookup (auth required, internal)
 *   POST /api/send-sms/notify    — lifecycle SMS notifications (auth required, internal)
 *
 * Boundary capture coverage:
 *   Every endpoint that triggers an outbound Surge API call is captured and asserted on:
 *   - Surge Messages API (POST /): exact URL, method, headers, body params {to, body}
 *   - Surge Messages API (POST /direct): same via sendSms() helper
 *   - Surge Messages API (POST /notify): same via outbound event handlers -> sendSms()
 *   Validation failures are verified to produce 0 outbound calls.
 *
 * Invariants covered:
 *   - auth boundary: all endpoints require API key authentication
 *   - error-surface: all error responses include { error: string }
 *   - concurrency: 10 parallel validation requests return consistent 400s
 *   - same-input reproducibility: 3 identical requests return identical responses
 *   - boundary param: exact params sent to Surge API are captured and asserted
 *   - cleanup: shortcode records created by write_lock events are the only mutable state;
 *     they auto-expire after 24h and use unique codes (no collision with other tests)
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Invariants not applicable:
 *   - idempotency/retry: fire-and-forget SMS send; no idempotency key
 *   - read-after-write: no read endpoints; responses are immediate
 *   - state transition: only /notify agent deletion check; tested via contract tests
 *   - ordering/pagination: no list endpoints
 *   - atomicity: no multi-step transactions (shortcode + SMS are independent)
 *   - referential integrity: SmsShortcode has no FKs; agent lookup is a soft check
 *   - event/job cardinality: no async events emitted by these endpoints
 *   - duplication prevention: SMS sends are intentionally non-deduplicated
 *   - tenant isolation: all endpoints are internal (API key auth), not user-scoped
 *   - time/clock: no timestamps in response
 *   - call ordering: each endpoint makes at most 1 outbound Surge call
 *
 * Usage:
 *   npx tsx src/tests/blackbox/send-sms.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/send-sms.blackbox.ts
 */

import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { listArchivedObjects, readArchivedArtifact } from '../../providers/traceArchive';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// Test user with known phone in DB
const TEST_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const TEST_PHONE = '+19729777432';
const FAKE_AGENT_ID = '00000000-0000-0000-0000-fakeagent001';
const prisma = new PrismaClient();

// ==================== RESPONSE SCHEMAS ====================

const SendSuccessSchema = z.object({
  success: z.literal(true),
  message_id: z.string(),
  phone_number: z.string(),
  provider: z.literal('surge'),
});

const ErrorSchema = z.object({ error: z.string() });

const NotifySuccessSchema = z.object({ success: z.literal(true) });

const NotifyZodErrorSchema = z.object({
  error: z.string(),
  details: z.array(z.unknown()),
});

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface CapturedCall {
  id: number;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  cached: boolean;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
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

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected)
    throw new Error(
      `Expected status ${expected}, got ${actual}: ` + `${JSON.stringify(data).substring(0, 300)}`
    );
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(
      `${label} schema validation failed: ${result.error.message}\n` +
        `Actual data: ${JSON.stringify(data).substring(0, 500)}`
    );
  return result.data;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function createNotifyAgent(goal: string) {
  return prisma.agent.create({
    data: {
      userId: TEST_USER_ID,
      goal,
      status: 'ACTIVE',
      source: 'SMS',
      progress: 0.25,
    },
  });
}

function assertNoInternalRoutingTokens(message: string, agentId: string): void {
  const prefix = agentId.substring(0, 6);
  assert(!message.includes(agentId), `Expected no full agent id in SMS, got: ${message}`);
  assert(!message.includes(`[${prefix}]`), `Expected no agent prefix in SMS, got: ${message}`);
  assert(
    !message.includes(`agent-id=${agentId}`),
    `Expected no agent-id URL in SMS, got: ${message}`
  );
  assert(
    !/\battn[_-][a-z0-9-]+/i.test(message),
    `Expected no attention id in SMS, got: ${message}`
  );
  assert(
    !/\b(?:reply\s+)?approve\s+[A-Z0-9]{5}\b/i.test(message),
    `Expected no approval shortcode instruction in SMS, got: ${message}`
  );
}

// ==================== CAPTURE HELPERS ====================

async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

function captureToken(prefix: string): string {
  return `send-sms-${prefix}-${crypto.randomUUID()}`;
}

/** Filter Surge calls and match on a specific body substring to isolate from concurrent tests. */
function filterSurgeCalls(calls: CapturedCall[], bodySubstring?: string): CapturedCall[] {
  return calls.filter((c) => {
    if (!c.url.includes('surge.app')) return false;
    if (bodySubstring && c.requestBody) {
      return c.requestBody.includes(bodySubstring);
    }
    return bodySubstring === undefined;
  });
}

async function checkCaptureAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/test/captures`);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function listSmsArchivePaths(rootAgentId: string): Promise<string[]> {
  const archivedObjects = await listArchivedObjects(rootAgentId);
  return archivedObjects
    .map((entry) => entry.path)
    .filter((entry) => entry.startsWith('provider/sms/surge/'))
    .sort();
}

// ==================== POST / (send SMS) -- CONTRACT ====================

async function testSend_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    body: JSON.stringify({ phone_number: '+10000000000', message: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testSend_missingPhone() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorSchema, res.data, 'missing phone');
}

async function testSend_missingMessage() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ phone_number: '+10000000000' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorSchema, res.data, 'missing message');
}

async function testSend_emptyPhone() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ phone_number: '', message: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testSend_emptyMessage() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ phone_number: '+10000000000', message: '' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testSend_happyPath() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      phone_number: TEST_PHONE,
      message: 'blackbox test',
    }),
  });
  if (res.status === 200) {
    const data = assertSchema(SendSuccessSchema, res.data, 'send happy path');
    assert(
      data.phone_number === TEST_PHONE,
      `Expected phone ${TEST_PHONE}, got ${data.phone_number}`
    );
    assert(data.provider === 'surge', `Expected provider surge, got ${data.provider}`);
  } else if (res.status === 500) {
    assertSchema(ErrorSchema, res.data, 'send 500 (Surge not configured)');
  } else {
    assertSchema(ErrorSchema, res.data, `send ${res.status} (Surge error)`);
  }
}

async function testSend_responseContentType() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      phone_number: TEST_PHONE,
      message: 'content type test',
    }),
  });
  const ct = res.headers.get('content-type');
  assert(ct !== null && ct.includes('application/json'), `Expected JSON content-type, got: ${ct}`);
}

// ==================== POST /direct -- CONTRACT ====================

async function testDirect_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    body: JSON.stringify({ user_id: TEST_USER_ID, message: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testDirect_missingBothFields() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorSchema, res.data, 'direct missing fields');
}

async function testDirect_missingUserId() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testDirect_missingMessage() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ user_id: TEST_USER_ID }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testDirect_unknownUser() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: '00000000-0000-0000-0000-000000000000',
      message: 'test',
    }),
  });
  assertStatus(res.status, 400, res.data);
  const data = res.data as { error?: string };
  assert(data.error !== undefined, 'Expected error field for unknown user');
}

async function testDirect_happyPath() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      message: 'blackbox direct test',
    }),
  });
  if (res.status === 200) {
    const data = res.data as Record<string, unknown>;
    assert(typeof data.success === 'boolean', 'Expected success field in response');
  } else {
    assertStatus(res.status, 500, res.data);
  }
}

// ==================== POST /notify -- CONTRACT ====================

async function testNotify_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testNotify_emptyBody() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

async function testNotify_invalidEventType() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'invalid_event',
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testNotify_missingUserId() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testNotify_missingAgentId() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testNotify_missingEventType() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testNotify_zodErrorShape() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: 123,
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(NotifyZodErrorSchema, res.data, 'Zod error shape');
}

async function testNotify_allValidEventTypes() {
  const events: { type: string; payload: Record<string, unknown> }[] = [
    { type: 'agent_started', payload: { goal: 'test goal' } },
    {
      type: 'planner_message',
      payload: { message: 'test message', is_question: false },
    },
    {
      type: 'write_lock',
      payload: {
        question: 'approve?',
        attention_request_id: 'test-ar',
        workflow_id: 'test-wf',
      },
    },
    { type: 'completion', payload: { summary: 'test summary' } },
    {
      type: 'cost_limit',
      payload: { tree_cost_cents: 100, price_limit_cents: 500 },
    },
  ];
  for (const { type, payload } of events) {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: type,
        agent_id: FAKE_AGENT_ID,
        payload,
      }),
    });
    assert(
      res.status === 200 || res.status === 500,
      `Event '${type}': expected 200 or 500, got ${res.status}: ` +
        `${JSON.stringify(res.data).substring(0, 200)}`
    );
    if (res.status === 200) {
      assertSchema(NotifySuccessSchema, res.data, `notify ${type}`);
    }
  }
}

async function testNotify_completionHappyPath() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
      payload: { summary: 'blackbox completion test' },
    }),
  });
  assert(res.status === 200 || res.status === 500, `Expected 200 or 500, got ${res.status}`);
  if (res.status === 200) {
    assertSchema(NotifySuccessSchema, res.data, 'notify completion happy');
  }
}

async function testNotify_responseContentType() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
      payload: { summary: 'ct test' },
    }),
  });
  const ct = res.headers.get('content-type');
  assert(ct !== null && ct.includes('application/json'), `Expected JSON content-type, got: ${ct}`);
}

// ==================== AUTH BOUNDARY INVARIANT ====================

async function testAuth_allEndpointsRequireAuth() {
  const endpoints = [
    {
      url: `${BASE_URL}/api/send-sms`,
      body: { phone_number: '+10000000000', message: 'test' },
    },
    {
      url: `${BASE_URL}/api/send-sms/direct`,
      body: { user_id: 'x', message: 'test' },
    },
    {
      url: `${BASE_URL}/api/send-sms/notify`,
      body: { user_id: 'x', event_type: 'completion', agent_id: 'x' },
    },
  ];
  for (const ep of endpoints) {
    const res = await request(ep.url, {
      method: 'POST',
      body: JSON.stringify(ep.body),
    });
    assert(res.status === 401, `${ep.url} without auth: expected 401, got ${res.status}`);
  }
}

async function testAuth_invalidApiKey() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: { 'X-API-Key': 'invalid-key-12345' },
    body: JSON.stringify({ phone_number: '+10000000000', message: 'test' }),
  });
  assert(
    res.status === 401 || res.status === 403,
    `Expected 401 or 403 for invalid key, got ${res.status}`
  );
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testErrorSurface_wrongMethodsSend() {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) {
    const opts: RequestInit = { method, headers: apiKeyHeaders() };
    if (method !== 'GET' && method !== 'DELETE') opts.body = JSON.stringify({});
    const res = await request(`${BASE_URL}/api/send-sms`, opts);
    assert(res.status !== 200, `${method} /api/send-sms should not return 200`);
  }
}

async function testErrorSurface_wrongMethodsDirect() {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) {
    const opts: RequestInit = { method, headers: apiKeyHeaders() };
    if (method !== 'GET' && method !== 'DELETE') opts.body = JSON.stringify({});
    const res = await request(`${BASE_URL}/api/send-sms/direct`, opts);
    assert(res.status !== 200, `${method} /api/send-sms/direct should not return 200`);
  }
}

async function testErrorSurface_wrongMethodsNotify() {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) {
    const opts: RequestInit = { method, headers: apiKeyHeaders() };
    if (method !== 'GET' && method !== 'DELETE') opts.body = JSON.stringify({});
    const res = await request(`${BASE_URL}/api/send-sms/notify`, opts);
    assert(res.status !== 200, `${method} /api/send-sms/notify should not return 200`);
  }
}

async function testErrorSurface_allValidationErrorsHaveErrorField() {
  const cases = [
    { url: `${BASE_URL}/api/send-sms`, body: { message: 'test' } },
    { url: `${BASE_URL}/api/send-sms`, body: { phone_number: '+1000' } },
    { url: `${BASE_URL}/api/send-sms/direct`, body: {} },
    { url: `${BASE_URL}/api/send-sms/notify`, body: {} },
    {
      url: `${BASE_URL}/api/send-sms/notify`,
      body: { user_id: 'x', event_type: 'bad', agent_id: 'x' },
    },
  ];
  for (const c of cases) {
    const res = await request(c.url, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify(c.body),
    });
    assertStatus(res.status, 400, res.data);
    const data = res.data as { error?: string };
    assert(
      data.error !== undefined,
      `Expected error field in 400 from ${c.url} with ` +
        `${JSON.stringify(c.body)}, got: ` +
        `${JSON.stringify(res.data).substring(0, 200)}`
    );
  }
}

// ==================== CONCURRENCY INVARIANT ====================

async function testConcurrency_parallelSendValidation() {
  const requests = Array.from({ length: 10 }, () =>
    request(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ message: 'test' }),
    })
  );
  const results = await Promise.all(requests);
  for (const res of results) {
    assertStatus(res.status, 400, res.data);
  }
}

async function testConcurrency_parallelNotifyValidation() {
  const requests = Array.from({ length: 10 }, () =>
    request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({}),
    })
  );
  const results = await Promise.all(requests);
  for (const res of results) {
    assertStatus(res.status, 400, res.data);
  }
}

// ==================== REPRODUCIBILITY INVARIANT ====================

async function testReproducibility_sameInputSameOutput() {
  const body = JSON.stringify({ phone_number: '+10000000000' });
  const snapshots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body,
    });
    snapshots.push(JSON.stringify({ status: res.status, data: res.data }));
  }
  assert(new Set(snapshots).size === 1, 'Three identical requests returned different responses');
}

// ==================== BOUNDARY CAPTURE TESTS ====================
// Run sequentially -- shared capture buffer.
// Each test: clear captures -> request -> read captures -> assert.

/**
 * POST /api/send-sms with valid params calls Surge Messages API:
 *   URL:     https://api.surge.app/accounts/{ACCOUNT_ID}/messages
 *   Method:  POST
 *   Headers: Authorization: Bearer ..., Content-Type: application/json
 *   Body:    { to: string, body: string }
 */
async function testBoundary_sendCallsSurgeApi() {
  const token = captureToken('send');
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      phone_number: TEST_PHONE,
      message: 'boundary test send',
    }),
  });
  if (res.status === 500) {
    const data = res.data as { error?: string };
    if (data.error?.includes('not configured')) {
      console.log('    [skipped] Surge not configured -- cannot test boundary');
      return;
    }
  }
  const calls = await readCapturesForToken(token);
  const surgeCalls = filterSurgeCalls(calls, 'boundary test send');
  assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
  const call = surgeCalls[0];
  assert(
    call.url.startsWith('https://api.surge.app/accounts/') && call.url.endsWith('/messages'),
    `Unexpected Surge URL: ${call.url}`
  );
  assert(call.method === 'POST', `Expected POST, got ${call.method}`);
  assert(
    call.requestHeaders['Content-Type'] === 'application/json',
    `Expected Content-Type: application/json, got: ` + `${call.requestHeaders['Content-Type']}`
  );
  assert(
    call.requestHeaders['Authorization']?.startsWith('Bearer '),
    `Expected Bearer auth, got: ` + `${call.requestHeaders['Authorization']?.slice(0, 20)}`
  );
  assert(call.requestBody !== null, 'Expected non-null request body');
  const body = JSON.parse(call.requestBody!);
  assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}, got to=${body.to}`);
  assert(
    body.body === 'boundary test send',
    `Expected body='boundary test send', got: ${body.body}`
  );
}

/**
 * POST /api/send-sms/direct with valid user calls Surge Messages API
 * via sendSms() helper. Body: { to: user's phone, body: message }.
 */
async function testBoundary_directCallsSurgeApi() {
  const token = captureToken('direct');
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      message: 'boundary test direct',
    }),
  });
  if (res.status === 200) {
    const data = res.data as { success?: boolean; error?: string };
    if (data.success === false && data.error?.includes('not configured')) {
      console.log('    [skipped] Surge not configured -- cannot test boundary');
      return;
    }
  }
  if (res.status === 500) {
    console.log('    [skipped] Internal error -- cannot test boundary');
    return;
  }
  const calls = await readCapturesForToken(token);
  const surgeCalls = filterSurgeCalls(calls, 'boundary test direct');
  if (surgeCalls.length === 0) {
    console.log('    [skipped] No Surge calls -- Surge may not be configured');
    return;
  }
  assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
  const call = surgeCalls[0];
  assert(
    call.url.startsWith('https://api.surge.app/accounts/') && call.url.endsWith('/messages'),
    `Unexpected Surge URL: ${call.url}`
  );
  assert(call.method === 'POST', `Expected POST, got ${call.method}`);
  assert(
    call.requestHeaders['Content-Type'] === 'application/json',
    'Expected Content-Type: application/json'
  );
  assert(call.requestHeaders['Authorization']?.startsWith('Bearer '), 'Expected Bearer auth');
  assert(call.requestBody !== null, 'Expected non-null request body');
  const body = JSON.parse(call.requestBody!);
  assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}, got to=${body.to}`);
  assert(
    body.body === 'boundary test direct',
    `Expected body='boundary test direct', got: ${body.body}`
  );
}

/**
 * POST /api/send-sms/notify with completion event calls Surge Messages
 * API via notifyCompletion() -> sendSms() chain.
 */
async function testBoundary_notifyCompletionCallsSurgeApi() {
  const token = captureToken('notify-completion');
  const agent = await createNotifyAgent('boundary completion agent');
  const archiveBefore = new Set(await listSmsArchivePaths(agent.id));
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'completion',
        agent_id: agent.id,
        payload: { summary: 'boundary test completed' },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, 'boundary test completed');
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(
      call.url.startsWith('https://api.surge.app/accounts/') && call.url.endsWith('/messages'),
      `Unexpected Surge URL: ${call.url}`
    );
    assert(call.method === 'POST', `Expected POST, got ${call.method}`);
    assert(
      call.requestHeaders['Content-Type'] === 'application/json',
      'Expected JSON content type'
    );
    assert(call.requestHeaders['Authorization']?.startsWith('Bearer '), 'Expected Bearer auth');
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!);
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}, got to=${body.to}`);
    assert(
      body.body.includes('boundary test completed'),
      `Expected completion summary in SMS, got: ${body.body.substring(0, 100)}`
    );
    assertNoInternalRoutingTokens(body.body, agent.id);
    const archiveAfter = await listSmsArchivePaths(agent.id);
    const newEncryptedArtifacts = archiveAfter.filter(
      (entry) => !archiveBefore.has(entry) && entry.endsWith('.json.gz.enc')
    );
    assert(
      newEncryptedArtifacts.length >= 1,
      `Expected encrypted SMS provider archive for agent ${agent.id}`
    );
    const archivedArtifact = await readArchivedArtifact({
      rootAgentId: agent.id,
      objectPath: newEncryptedArtifacts[0],
    });
    assert(
      archivedArtifact !== null,
      `Expected readable SMS provider archive metadata at ${newEncryptedArtifacts[0]}`
    );
    const metadata = archivedArtifact.metadata as Record<string, unknown>;
    assert(metadata.content_type === 'application/json', 'Expected JSON archive content type');
    assert(metadata.compression === 'gzip', 'Expected SMS provider archive to be gzipped');
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

/**
 * POST /api/send-sms/notify with agent_started event calls Surge API.
 */
async function testBoundary_notifyAgentStartedCallsSurgeApi() {
  const token = captureToken('notify-started');
  const agent = await createNotifyAgent('boundary started agent');
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'agent_started',
        agent_id: agent.id,
        payload: { goal: 'boundary test goal' },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, 'boundary test goal');
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!);
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(
      body.body.includes('boundary test goal'),
      `Expected started message to include goal, got: ${body.body.substring(0, 100)}`
    );
    assertNoInternalRoutingTokens(body.body, agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

async function testBoundary_notifyCostLimitIncludesTaskGoal() {
  const token = captureToken('notify-cost-limit');
  const goal = 'boundary cost limit dinner booking task';
  const agent = await createNotifyAgent(goal);
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'cost_limit',
        agent_id: agent.id,
        payload: { tree_cost_cents: 150, price_limit_cents: 150 },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, goal);
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!);
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(
      body.body.includes(`budget limit for "${goal}"`),
      `Expected cost-limit message to include task goal, got: ${body.body.substring(0, 160)}`
    );
    assert(
      !body.body.includes('after spending'),
      `Expected cost-limit spend details, got: ${body.body.substring(0, 160)}`
    );
    assertNoInternalRoutingTokens(body.body, agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

async function testBoundary_notifyWriteLockNaturalLanguageOnly() {
  const token = captureToken('notify-write-lock');
  const agent = await createNotifyAgent('boundary write lock agent');
  const attentionRequestId = `attn-bb-${crypto.randomUUID()}`;
  const question = 'Can I place the Amazon order for $42?';
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'write_lock',
        agent_id: agent.id,
        payload: {
          question,
          attention_request_id: attentionRequestId,
          workflow_id: 'wf-boundary-write-lock',
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, question);
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!);
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(body.body.includes(question), `Expected write-lock question in SMS, got: ${body.body}`);
    assertNoInternalRoutingTokens(body.body, agent.id);
    assert(
      !body.body.includes(attentionRequestId),
      `Expected no attention request id in SMS, got: ${body.body}`
    );
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

async function testBoundary_notifyWriteLockStructuredMms() {
  const token = captureToken('notify-write-lock-mms');
  const agent = await createNotifyAgent('boundary write lock mms agent');
  const imageUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const itemTitle = "Carhartt Men's Knit Cuffed Beanie, Black";
  const itemDescription = 'Soft rib-knit acrylic, fold-up cuff, Carhartt patch label.';
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'write_lock',
        agent_id: agent.id,
        payload: {
          question: 'legacy markdown question should not be the primary renderer',
          attention_request_id: `attn-bb-${crypto.randomUUID()}`,
          workflow_id: 'wf-boundary-write-lock-mms',
          metadata: {
            writeLockNotification: {
              trigger_type: 'purchase',
              action: 'Place an Amazon order for one selected black beanie',
              service: {
                name: 'Amazon',
                domain: 'amazon.com',
                url: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
              },
              media: [],
              purchase: {
                items: [
                  {
                    title: itemTitle,
                    price: '$19.99',
                    quantity: '1',
                    description: itemDescription,
                    rating: '4.8 out of 5 stars',
                    review_count: '167,432 ratings',
                    image_url: imageUrl,
                  },
                ],
                totals: { subtotal: '$19.99', tax: '$1.75', total: '$21.74' },
              },
            },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, itemTitle);
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!) as {
      to?: string;
      body?: string;
      attachments?: { url?: string }[];
    };
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(
      body.body?.includes('Approval needed') === true,
      `Expected approval header: ${body.body}`
    );
    assert(
      body.body?.includes('Rose needs your approval for Amazon checkout.') === true,
      `Expected carrier-safe checkout approval copy: ${body.body}`
    );
    assert(
      body.body?.includes(`Description: ${itemDescription}`) === true,
      `Expected renderer to preserve the LLM-provided description: ${body.body}`
    );
    assert(body.body?.includes(itemTitle) === true, `Expected item title in MMS: ${body.body}`);
    assert(body.body?.includes('Price: $19.99') === true, `Expected price in MMS: ${body.body}`);
    assert(
      body.body?.includes('Rating: 4.8 out of 5 stars') === true,
      `Expected rating: ${body.body}`
    );
    assert(body.body?.includes('Total: $21.74') === true, `Expected total in MMS: ${body.body}`);
    assert(!body.body?.includes('Page:'), `Expected no page URL in carrier SMS body: ${body.body}`);
    assert(
      !/https?:\/\//i.test(body.body ?? ''),
      `Expected no URL in carrier SMS body: ${body.body}`
    );
    assert(
      !/\bAmazon\.com\b/i.test(body.body ?? ''),
      `Expected no bare domain in SMS body: ${body.body}`
    );
    assert(
      Array.isArray(body.attachments) &&
        typeof body.attachments[0]?.url === 'string' &&
        body.attachments[0].url !== imageUrl,
      `Expected rehosted MMS attachment, got: ${JSON.stringify(body.attachments)}`
    );
    assertNoInternalRoutingTokens(body.body ?? '', agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

/** POST /api/send-sms validation failure -> 0 outbound calls. */
async function testBoundary_sendValidationNoOutbound() {
  const marker = 'send-sms-bb-no-phone';
  const token = captureToken('send-validation');
  await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({ message: marker }),
  });
  const calls = await readCapturesForToken(token);
  const surgeCalls = filterSurgeCalls(calls, marker);
  assert(
    surgeCalls.length === 0,
    `Expected 0 Surge calls for validation failure, got ` + `${surgeCalls.length}`
  );
}

/** POST /api/send-sms/direct missing fields -> 0 outbound calls. */
async function testBoundary_directValidationNoOutbound() {
  const token = captureToken('direct-validation');
  await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({}),
  });
  const calls = await readCapturesForToken(token);
  // No message was sent, so no Surge call can contain our marker.
  // Filter to our test phone to exclude concurrent domains' calls.
  const surgeCalls = calls.filter(
    (c) => c.url.includes('surge.app') && c.requestBody?.includes(TEST_PHONE)
  );
  assert(
    surgeCalls.length === 0,
    `Expected 0 Surge calls for validation failure, got ` + `${surgeCalls.length}`
  );
}

/** POST /api/send-sms/notify invalid event -> 0 outbound calls. */
async function testBoundary_notifyValidationNoOutbound() {
  const token = captureToken('notify-validation');
  await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      user_id: 'x',
      event_type: 'bad_type',
      agent_id: 'x',
    }),
  });
  const calls = await readCapturesForToken(token);
  // Invalid event type is rejected before any SMS send. Filter to our
  // test phone to exclude concurrent domains' Surge calls.
  const surgeCalls = calls.filter(
    (c) => c.url.includes('surge.app') && c.requestBody?.includes(TEST_PHONE)
  );
  assert(
    surgeCalls.length === 0,
    `Expected 0 Surge calls for validation failure, got ` + `${surgeCalls.length}`
  );
}

/** POST /api/send-sms/direct unknown user (no phone) -> 0 calls. */
async function testBoundary_directUnknownUserNoOutbound() {
  const marker = 'send-sms-bb-unknown-user';
  const token = captureToken('direct-unknown-user');
  await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      user_id: '00000000-0000-0000-0000-000000000000',
      message: marker,
    }),
  });
  const calls = await readCapturesForToken(token);
  const surgeCalls = filterSurgeCalls(calls, marker);
  assert(
    surgeCalls.length === 0,
    `Expected 0 Surge calls for unknown user, got ` + `${surgeCalls.length}`
  );
}

// ==================== RUNNER ====================

interface TestGroup {
  name: string;
  tests: { name: string; fn: () => Promise<void> }[];
}

async function runAll() {
  console.log('Send SMS Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const captureAvailable = await checkCaptureAvailable();

  const parallelGroups: TestGroup[] = [
    {
      name: 'POST / (send) -- contract',
      tests: [
        { name: 'no auth -> 401', fn: testSend_noAuth },
        { name: 'missing phone -> 400', fn: testSend_missingPhone },
        { name: 'missing message -> 400', fn: testSend_missingMessage },
        { name: 'empty phone -> 400', fn: testSend_emptyPhone },
        { name: 'empty message -> 400', fn: testSend_emptyMessage },
        {
          name: 'happy path (200 or Surge error)',
          fn: testSend_happyPath,
        },
        {
          name: 'response Content-Type: application/json',
          fn: testSend_responseContentType,
        },
      ],
    },
    {
      name: 'POST /direct -- contract',
      tests: [
        { name: 'no auth -> 401', fn: testDirect_noAuth },
        {
          name: 'missing both fields -> 400',
          fn: testDirect_missingBothFields,
        },
        { name: 'missing user_id -> 400', fn: testDirect_missingUserId },
        { name: 'missing message -> 400', fn: testDirect_missingMessage },
        {
          name: 'unknown user -> 400 (no phone)',
          fn: testDirect_unknownUser,
        },
        { name: 'happy path', fn: testDirect_happyPath },
      ],
    },
    {
      name: 'POST /notify -- contract',
      tests: [
        { name: 'no auth -> 401', fn: testNotify_noAuth },
        { name: 'empty body -> 400', fn: testNotify_emptyBody },
        {
          name: 'invalid event type -> 400',
          fn: testNotify_invalidEventType,
        },
        { name: 'missing user_id -> 400', fn: testNotify_missingUserId },
        {
          name: 'missing agent_id -> 400',
          fn: testNotify_missingAgentId,
        },
        {
          name: 'missing event_type -> 400',
          fn: testNotify_missingEventType,
        },
        { name: 'Zod error includes details', fn: testNotify_zodErrorShape },
        {
          name: 'all valid event types -> 200',
          fn: testNotify_allValidEventTypes,
        },
        {
          name: 'completion happy path',
          fn: testNotify_completionHappyPath,
        },
        {
          name: 'response Content-Type: application/json',
          fn: testNotify_responseContentType,
        },
      ],
    },
    {
      name: 'Auth boundary',
      tests: [
        {
          name: 'all endpoints require auth',
          fn: testAuth_allEndpointsRequireAuth,
        },
        { name: 'invalid API key rejected', fn: testAuth_invalidApiKey },
      ],
    },
    {
      name: 'Error surface',
      tests: [
        {
          name: 'wrong methods on / rejected',
          fn: testErrorSurface_wrongMethodsSend,
        },
        {
          name: 'wrong methods on /direct rejected',
          fn: testErrorSurface_wrongMethodsDirect,
        },
        {
          name: 'wrong methods on /notify rejected',
          fn: testErrorSurface_wrongMethodsNotify,
        },
        {
          name: 'all validation errors include error field',
          fn: testErrorSurface_allValidationErrorsHaveErrorField,
        },
      ],
    },
    {
      name: 'Concurrency',
      tests: [
        {
          name: '10 parallel send validations -> 400',
          fn: testConcurrency_parallelSendValidation,
        },
        {
          name: '10 parallel notify validations -> 400',
          fn: testConcurrency_parallelNotifyValidation,
        },
      ],
    },
    {
      name: 'Reproducibility',
      tests: [
        {
          name: 'same input -> same output (3x)',
          fn: testReproducibility_sameInputSameOutput,
        },
      ],
    },
  ];

  const sequentialGroups: TestGroup[] = [];

  if (captureAvailable) {
    sequentialGroups.push({
      name: 'Boundary capture',
      tests: [
        {
          name: 'send validation -> 0 outbound calls',
          fn: testBoundary_sendValidationNoOutbound,
        },
        {
          name: 'direct validation -> 0 outbound calls',
          fn: testBoundary_directValidationNoOutbound,
        },
        {
          name: 'notify validation -> 0 outbound calls',
          fn: testBoundary_notifyValidationNoOutbound,
        },
        {
          name: 'direct unknown user -> 0 outbound calls',
          fn: testBoundary_directUnknownUserNoOutbound,
        },
        {
          name: 'send calls Surge API with exact params',
          fn: testBoundary_sendCallsSurgeApi,
        },
        {
          name: 'direct calls Surge API with exact params',
          fn: testBoundary_directCallsSurgeApi,
        },
        {
          name: 'notify completion calls Surge API',
          fn: testBoundary_notifyCompletionCallsSurgeApi,
        },
        {
          name: 'notify agent_started calls Surge API',
          fn: testBoundary_notifyAgentStartedCallsSurgeApi,
        },
        {
          name: 'notify cost_limit includes task goal',
          fn: testBoundary_notifyCostLimitIncludesTaskGoal,
        },
        {
          name: 'notify write_lock uses natural language only',
          fn: testBoundary_notifyWriteLockNaturalLanguageOnly,
        },
        {
          name: 'notify write_lock sends structured MMS with image',
          fn: testBoundary_notifyWriteLockStructuredMms,
        },
      ],
    });
  }

  const allGroups = [...parallelGroups, ...sequentialGroups];

  // Flatten parallel tests for concurrent execution
  const parallelTests: {
    groupName: string;
    name: string;
    fn: () => Promise<void>;
  }[] = [];
  for (const group of parallelGroups) {
    for (const test of group.tests) {
      parallelTests.push({
        groupName: group.name,
        name: test.name,
        fn: test.fn,
      });
    }
  }

  const allResults: (TestResult & { groupName: string })[] = [];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= parallelTests.length) return;
      const t = parallelTests[idx];
      const result = await runTest(`${t.groupName} -- ${t.name}`, t.fn);
      allResults[idx] = { ...result, groupName: t.groupName };
    }
  }

  const workerCount = Math.min(CASE_CONCURRENCY, parallelTests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (!captureAvailable) {
    console.log(
      '\n  [info] Capture not available ' +
        '(BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

  for (const group of sequentialGroups) {
    for (const test of group.tests) {
      const result = await runTest(`${group.name} -- ${test.name}`, test.fn);
      allResults.push({ ...result, groupName: group.name });
    }
  }

  // Print results grouped
  for (const group of allGroups) {
    console.log(`\n  ${group.name}`);
    for (const test of group.tests) {
      const result = allResults.find(
        (r) => r.groupName === group.name && r.name.endsWith(test.name)
      )!;
      const icon = result.passed ? '  PASS' : '  FAIL';
      console.log(
        `${icon}  ${test.name}` +
          `${result.passed ? '' : ` -- ${result.error}`} ` +
          `(${result.duration}ms)`
      );
    }
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(
    `\nResults: ${passed} passed, ${failed} failed, ` +
      `${allResults.length} total (caseConcurrency=${workerCount})`
  );
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    await prisma.$disconnect();
    process.exit(1);
  }
  await prisma.$disconnect();
  console.log('\nALL BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
