#!/usr/bin/env tsx
/**
 * Black-box tests for /api/tool-usage
 *
 * Domain surface:
 *   POST /api/tool-usage      — API key auth, creates tool usage record for an agent
 *   GET  /api/tool-usage/:id  — API key or JWT auth, returns usage summary for an agent
 *
 * Boundary capture coverage:
 *   Zero outbound third-party HTTP calls. Both endpoints are pure database CRUD.
 *   A boundary capture test verifies no outbound calls are triggered.
 *
 * Invariants covered:
 *   - auth boundary: both endpoints require auth (401 without)
 *   - error-surface: all error responses have { error: string }
 *   - read-after-write consistency: POST then GET returns created record
 *   - tenant isolation: JWT user cannot see another user's agent usage
 *   - idempotency: multiple POSTs create separate records (no upsert)
 *   - ordering: usages returned in createdAt ascending order
 *   - concurrency: parallel GETs return consistent results
 *   - same-input reproducibility: sequential GETs return identical responses
 *   - boundary param: no outbound calls made (verified via fetch capture)
 *   - cleanup: test agent is deleted after tests complete
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Invariants not applicable:
 *   - state transition: no state machine, just append-only records
 *   - atomicity: single-row inserts, no multi-table transactions
 *   - referential integrity: tested via agent ownership checks (403)
 *   - event/job cardinality: no events emitted
 *   - time/clock: createdAt is server-generated, not user-supplied
 *   - call ordering: no outbound calls to order
 *   - pagination: no pagination support in these endpoints
 *
 * Usage:
 *   npx tsx src/tests/blackbox/tool-usage.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/tool-usage.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponseSchema = z.object({ error: z.string() });
const CreateToolUsageResponseSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  tool_name: z.string(),
  total_cost_cents: z.number(),
  created_at: z.string().or(z.date()),
});
const UsageItemSchema = z.object({
  id: z.string(),
  tool_name: z.string(),
  total_cost_cents: z.number(),
  usage_items: z.any(),
  created_at: z.string().or(z.date()),
});
const GetToolUsageResponseSchema = z.object({
  agent_id: z.string(),
  tool_usage_count: z.number(),
  total_cost_cents: z.number(),
  total_cost_dollars: z.number(),
  total_tokens_from_tools: z.number(),
  usages: z.array(UsageItemSchema),
});

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}
interface TestContext {
  user1Token?: string;
  user1Id?: string;
  user2Token?: string;
  user2Id?: string;
  agentId?: string;
  createdUsageIds: string[];
}
const ctx: TestContext = { createdUsageIds: [] };

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data: unknown;
  if (response.headers.get('content-type')?.includes('application/json')) {
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

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected)
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
}
function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  return result.data;
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
function apiKeyHeaders(userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': API_KEY };
  if (userId) h['X-User-Id'] = userId;
  return h;
}

const FAKE_AGENT_ID = '00000000-0000-0000-0000-000000000000';

function postUsage(body: Record<string, unknown>, headers?: Record<string, string>) {
  return request(`${BASE_URL}/api/tool-usage`, {
    method: 'POST',
    headers: headers ?? apiKeyHeaders(),
    body: JSON.stringify(body),
  });
}
function getUsage(agentId: string, headers: Record<string, string>) {
  return request(`${BASE_URL}/api/tool-usage/${agentId}`, { headers });
}

// ==================== SETUP ====================

async function setupAuth(): Promise<void> {
  const [res1, res2] = await Promise.all([
    request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' }),
    request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' }),
  ]);
  assertStatus(res1.status, 200, res1.data);
  assertStatus(res2.status, 200, res2.data);
  const d1 = res1.data as { session: { access_token: string }; user: { id: string } };
  const d2 = res2.data as { session: { access_token: string }; user: { id: string } };
  ctx.user1Token = d1.session.access_token;
  ctx.user1Id = d1.user.id;
  ctx.user2Token = d2.session.access_token;
  ctx.user2Id = d2.user.id;
}

async function createTestAgent(): Promise<void> {
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.user1Id!),
    body: JSON.stringify({ goal: 'Tool-usage blackbox test agent - do nothing' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as { agent_id: string };
  assert(!!body.agent_id, `Missing agent_id: ${JSON.stringify(res.data).substring(0, 300)}`);
  ctx.agentId = body.agent_id;
}

async function cleanup(): Promise<void> {
  if (ctx.agentId)
    await request(`${BASE_URL}/api/agents/${ctx.agentId}`, {
      method: 'DELETE',
      headers: apiKeyHeaders(ctx.user1Id!),
    });
}

// ==================== POST — AUTH & VALIDATION ====================

async function testCreate_noAuth() {
  const res = await postUsage(
    { agent_id: 'x', user_id: 'x', tool_name: 'test', total_cost_cents: 0, usage_items: [] },
    {}
  );
  assertStatus(res.status, 401, res.data);
}
async function testCreate_missingAgentId() {
  const res = await postUsage({
    user_id: ctx.user1Id,
    tool_name: 'test',
    total_cost_cents: 0,
    usage_items: [],
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'missing agent_id');
}
async function testCreate_missingUserId() {
  const res = await postUsage({
    agent_id: ctx.agentId,
    tool_name: 'test',
    total_cost_cents: 0,
    usage_items: [],
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'missing user_id');
}
async function testCreate_missingToolName() {
  const res = await postUsage({
    agent_id: ctx.agentId,
    user_id: ctx.user1Id,
    total_cost_cents: 0,
    usage_items: [],
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'missing tool_name');
}
async function testCreate_badTotalCostCents() {
  const res = await postUsage({
    agent_id: ctx.agentId,
    user_id: ctx.user1Id,
    tool_name: 'test',
    total_cost_cents: 'not-a-number',
    usage_items: [],
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'bad total_cost_cents');
}
async function testCreate_badUsageItems() {
  const res = await postUsage({
    agent_id: ctx.agentId,
    user_id: ctx.user1Id,
    tool_name: 'test',
    total_cost_cents: 0,
    usage_items: 'not-an-array',
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'bad usage_items');
}
async function testCreate_agentNotFound() {
  const res = await postUsage({
    agent_id: FAKE_AGENT_ID,
    user_id: ctx.user1Id,
    tool_name: 'test',
    total_cost_cents: 0,
    usage_items: [],
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'agent not found');
}
async function testCreate_agentOwnershipMismatch() {
  const res = await postUsage({
    agent_id: ctx.agentId,
    user_id: ctx.user2Id,
    tool_name: 'test',
    total_cost_cents: 0,
    usage_items: [],
  });
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'ownership mismatch');
}

// ==================== POST — HAPPY PATH ====================

async function testCreate_happy() {
  const res = await postUsage({
    agent_id: ctx.agentId,
    user_id: ctx.user1Id,
    tool_name: 'web_search',
    total_cost_cents: 42,
    usage_items: [{ type: 'api_call', description: 'search query' }],
  });
  assertStatus(res.status, 201, res.data);
  const body = assertSchema(CreateToolUsageResponseSchema, res.data, 'POST / happy');
  assert(body.agent_id === ctx.agentId, `agent_id mismatch: ${body.agent_id} vs ${ctx.agentId}`);
  assert(body.tool_name === 'web_search', `tool_name mismatch: ${body.tool_name}`);
  assert(body.total_cost_cents === 42, `total_cost_cents mismatch: ${body.total_cost_cents}`);
  ctx.createdUsageIds.push(body.id);
}
async function testCreate_contentType() {
  const res = await postUsage({
    agent_id: ctx.agentId,
    user_id: ctx.user1Id,
    tool_name: 'ct_check',
    total_cost_cents: 1,
    usage_items: [],
  });
  assertStatus(res.status, 201, res.data);
  const ct = res.headers.get('content-type');
  assert(ct !== null && ct.includes('application/json'), `Expected application/json, got: ${ct}`);
  ctx.createdUsageIds.push((res.data as { id: string }).id);
}

// ==================== GET — AUTH & ERRORS ====================

async function testGet_noAuth() {
  const res = await request(`${BASE_URL}/api/tool-usage/${FAKE_AGENT_ID}`);
  assertStatus(res.status, 401, res.data);
}
async function testGet_notFound() {
  const res = await getUsage(FAKE_AGENT_ID, apiKeyHeaders());
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'not found');
}
async function testGet_jwtOtherUserDenied() {
  const res = await getUsage(ctx.agentId!, authHeaders(ctx.user2Token!));
  assertStatus(res.status, 403, res.data);
  assertSchema(ErrorResponseSchema, res.data, 'tenant isolation');
}
async function testErrorSurface_allErrorsHaveErrorField() {
  const errorResponses = await Promise.all([
    request(`${BASE_URL}/api/tool-usage`, { method: 'POST', body: JSON.stringify({}) }),
    request(`${BASE_URL}/api/tool-usage/${FAKE_AGENT_ID}`),
    postUsage({ user_id: 'x', tool_name: 'x', total_cost_cents: 0, usage_items: [] }),
  ]);
  for (const res of errorResponses) {
    if (res.status >= 400) assertSchema(ErrorResponseSchema, res.data, `Error (${res.status})`);
  }
}

// ==================== READ-AFTER-WRITE + AGGREGATION ====================

async function testReadAfterWrite_apiKey() {
  const res = await getUsage(ctx.agentId!, apiKeyHeaders(ctx.user1Id!));
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetToolUsageResponseSchema, res.data, 'GET /:agentId');
  assert(body.agent_id === ctx.agentId, 'agent_id mismatch');
  assert(body.tool_usage_count >= 1, `Expected >= 1 usage, got ${body.tool_usage_count}`);
  const found = body.usages.find((u) => u.tool_name === 'web_search');
  assert(!!found, 'web_search usage not found');
  assert(found!.total_cost_cents === 42, `Cost mismatch: ${found!.total_cost_cents}`);
}
async function testReadAfterWrite_jwtOwner() {
  const res = await getUsage(ctx.agentId!, authHeaders(ctx.user1Token!));
  assertStatus(res.status, 200, res.data);
  assertSchema(GetToolUsageResponseSchema, res.data, 'GET /:agentId JWT');
}
async function testCostAggregation() {
  const res = await getUsage(ctx.agentId!, apiKeyHeaders(ctx.user1Id!));
  assertStatus(res.status, 200, res.data);
  const body = res.data as {
    total_cost_cents: number;
    total_cost_dollars: number;
    usages: { total_cost_cents: number }[];
  };
  const expectedCents = body.usages.reduce((sum, u) => sum + u.total_cost_cents, 0);
  assert(
    body.total_cost_cents === expectedCents,
    `total_cost_cents ${body.total_cost_cents} != sum ${expectedCents}`
  );
  assert(
    body.total_cost_dollars === expectedCents / 100,
    `total_cost_dollars ${body.total_cost_dollars} != ${expectedCents / 100}`
  );
}
async function testTokenAggregation() {
  // Create usage with LLM items + a non-LLM item with number_of_tokens (should NOT be counted)
  const res = await postUsage({
    agent_id: ctx.agentId,
    user_id: ctx.user1Id,
    tool_name: 'llm_call',
    total_cost_cents: 10,
    usage_items: [
      { type: 'llm', number_of_tokens: 500, description: 'prompt' },
      { type: 'llm', number_of_tokens: 300, description: 'completion' },
      { type: 'api_call', number_of_tokens: 9999, description: 'non-llm with tokens' },
    ],
  });
  assertStatus(res.status, 201, res.data);
  ctx.createdUsageIds.push((res.data as { id: string }).id);
  const getRes = await getUsage(ctx.agentId!, apiKeyHeaders(ctx.user1Id!));
  assertStatus(getRes.status, 200, getRes.data);
  const body = getRes.data as { total_tokens_from_tools: number };
  // At this point, prior usages have 0 LLM tokens (web_search, ct_check), so total should be exactly 800
  assert(
    body.total_tokens_from_tools === 800,
    `Expected total_tokens === 800, got ${body.total_tokens_from_tools} (non-LLM tokens may be leaking)`
  );
}
async function testUsageOrdering() {
  const res = await getUsage(ctx.agentId!, apiKeyHeaders(ctx.user1Id!));
  assertStatus(res.status, 200, res.data);
  const body = res.data as { usages: { created_at: string }[] };
  for (let i = 1; i < body.usages.length; i++) {
    const prev = new Date(body.usages[i - 1].created_at).getTime();
    const curr = new Date(body.usages[i].created_at).getTime();
    assert(
      curr >= prev,
      `Usages not ordered: ${body.usages[i - 1].created_at} > ${body.usages[i].created_at}`
    );
  }
}

// ==================== IDEMPOTENCY / CONCURRENCY / REPRODUCIBILITY / BOUNDARY ====================

async function testIdempotency_twoPostsCreateTwoRecords() {
  const payload = {
    agent_id: ctx.agentId,
    user_id: ctx.user1Id,
    tool_name: 'idempotency_test',
    total_cost_cents: 5,
    usage_items: [],
  };
  const [res1, res2] = await Promise.all([postUsage(payload), postUsage(payload)]);
  assertStatus(res1.status, 201, res1.data);
  assertStatus(res2.status, 201, res2.data);
  const id1 = (res1.data as { id: string }).id;
  const id2 = (res2.data as { id: string }).id;
  assert(id1 !== id2, `Both POSTs returned same id: ${id1}`);
  ctx.createdUsageIds.push(id1, id2);
}
async function testConcurrency_parallelGETs() {
  const reqs = Array.from({ length: 10 }, () =>
    getUsage(ctx.agentId!, apiKeyHeaders(ctx.user1Id!))
  );
  const results = await Promise.all(reqs);
  const statuses = new Set(results.map((r) => r.status));
  assert(statuses.size === 1, `Mixed statuses: ${[...statuses]}`);
  if (results[0].status === 200) {
    const baseline = JSON.stringify(results[0].data);
    for (let i = 1; i < results.length; i++)
      assert(JSON.stringify(results[i].data) === baseline, `Concurrent GET ${i} differs`);
  }
}
async function testReproducibility_threeGETs() {
  const snapshots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await getUsage(ctx.agentId!, apiKeyHeaders(ctx.user1Id!));
    snapshots.push(JSON.stringify({ status: res.status, data: res.data }));
  }
  assert(new Set(snapshots).size === 1, 'Three sequential GETs did not return identical responses');
}

const KNOWN_THIRD_PARTY_HOSTS = [
  'openrouter.ai',
  'supabase.co',
  'github.com',
  'ip-api.com',
  'surge.app',
  'stripe.com',
  'e2b.app',
  'verify.twilio.com',
  'api.steel.dev',
  'parallel.ai',
  'supabase.co',
  'twilio.com',
  'googleapis.com',
  'perplexity.ai',
  'exa.ai',
  'anthropic.com',
  'openai.com',
  'vapi.ai',
];
function isThirdPartyCapture(url: string): boolean {
  const lower = url.toLowerCase();
  return KNOWN_THIRD_PARTY_HOSTS.some((h) => lower.includes(h));
}

async function testBoundary_noOutboundCalls() {
  const captureToken = `tool-usage-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cursorRes = await request(`${BASE_URL}/api/test/captures`);
  if (cursorRes.status !== 200) {
    console.warn('    SKIP: capture harness not active (BLACKBOX_TEST_CAPTURE_OUTBOUND not set)');
    return;
  }
  await postUsage(
    {
      agent_id: ctx.agentId,
      user_id: ctx.user1Id,
      tool_name: 'boundary_test',
      total_cost_cents: 0,
      usage_items: [],
    },
    {
      ...apiKeyHeaders(ctx.user1Id!),
      'X-Capture-Token': captureToken,
    }
  );
  await getUsage(ctx.agentId!, {
    ...apiKeyHeaders(ctx.user1Id!),
    'X-Capture-Token': captureToken,
  });
  const capturesRes = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const captures = (capturesRes.data as { captures: { id: number; url: string }[] }).captures;
  const domainCaptures = captures.filter((c) => !isThirdPartyCapture(c.url));
  assert(
    domainCaptures.length === 0,
    `Expected 0 outbound calls from tool-usage, got ${domainCaptures.length}: ${JSON.stringify(domainCaptures).substring(0, 500)}`
  );
}

// ==================== RUNNER ====================

interface TestGroup {
  name: string;
  tests: { name: string; fn: () => Promise<void> }[];
}

async function runAll() {
  console.log('Tool-Usage Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);
  console.log('Setting up auth...');
  await setupAuth();
  console.log(`  User 1: ${ctx.user1Id}\n  User 2: ${ctx.user2Id}`);
  console.log('Creating test agent...');
  await createTestAgent();
  console.log(`  Agent: ${ctx.agentId}\n`);

  const parallelGroups: TestGroup[] = [
    {
      name: 'POST /api/tool-usage -- auth boundary',
      tests: [{ name: 'no auth -> 401', fn: testCreate_noAuth }],
    },
    {
      name: 'POST /api/tool-usage -- validation',
      tests: [
        { name: 'missing agent_id -> 400', fn: testCreate_missingAgentId },
        { name: 'missing user_id -> 400', fn: testCreate_missingUserId },
        { name: 'missing tool_name -> 400', fn: testCreate_missingToolName },
        { name: 'total_cost_cents not a number -> 400', fn: testCreate_badTotalCostCents },
        { name: 'usage_items not an array -> 400', fn: testCreate_badUsageItems },
        { name: 'agent not found -> 404', fn: testCreate_agentNotFound },
        { name: 'agent ownership mismatch -> 403', fn: testCreate_agentOwnershipMismatch },
      ],
    },
    {
      name: 'GET /api/tool-usage/:agentId -- auth boundary',
      tests: [
        { name: 'no auth -> 401', fn: testGet_noAuth },
        { name: 'not found -> 404', fn: testGet_notFound },
      ],
    },
    {
      name: 'GET /api/tool-usage/:agentId -- tenant isolation',
      tests: [{ name: 'JWT other user denied -> 403', fn: testGet_jwtOtherUserDenied }],
    },
    {
      name: 'Error surface',
      tests: [
        { name: 'all errors have { error: string }', fn: testErrorSurface_allErrorsHaveErrorField },
      ],
    },
  ];

  const sequentialGroups: TestGroup[] = [
    {
      name: 'POST /api/tool-usage -- happy path',
      tests: [
        { name: 'create usage -> 201 + schema', fn: testCreate_happy },
        { name: 'Content-Type is application/json', fn: testCreate_contentType },
      ],
    },
    {
      name: 'Read-after-write + aggregation',
      tests: [
        { name: 'GET returns created usage (API key)', fn: testReadAfterWrite_apiKey },
        { name: 'GET returns created usage (JWT owner)', fn: testReadAfterWrite_jwtOwner },
        { name: 'cost aggregation is correct', fn: testCostAggregation },
        { name: 'token aggregation (LLM only)', fn: testTokenAggregation },
        { name: 'usages ordered by createdAt', fn: testUsageOrdering },
      ],
    },
    {
      name: 'Idempotency',
      tests: [
        { name: 'two POSTs create two records', fn: testIdempotency_twoPostsCreateTwoRecords },
      ],
    },
    {
      name: 'Concurrency',
      tests: [{ name: '10 parallel GETs consistent', fn: testConcurrency_parallelGETs }],
    },
    {
      name: 'Reproducibility',
      tests: [{ name: 'three sequential GETs identical', fn: testReproducibility_threeGETs }],
    },
    {
      name: 'Boundary capture',
      tests: [{ name: 'zero outbound calls on POST + GET', fn: testBoundary_noOutboundCalls }],
    },
  ];

  const allGroups = [...parallelGroups, ...sequentialGroups];
  const parallelTests: { groupName: string; name: string; fn: () => Promise<void> }[] = [];
  for (const group of parallelGroups)
    for (const test of group.tests)
      parallelTests.push({ groupName: group.name, name: test.name, fn: test.fn });

  const allResults: (TestResult & { groupName: string })[] = [];
  try {
    let nextIdx = 0;
    async function worker(): Promise<void> {
      while (true) {
        const idx = nextIdx++;
        if (idx >= parallelTests.length) return;
        const t = parallelTests[idx];
        allResults[idx] = {
          ...(await runTest(`${t.groupName} -- ${t.name}`, t.fn)),
          groupName: t.groupName,
        };
      }
    }
    const workerCount = Math.min(CASE_CONCURRENCY, parallelTests.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    for (const group of sequentialGroups) {
      for (const test of group.tests)
        allResults.push({
          ...(await runTest(`${group.name} -- ${test.name}`, test.fn)),
          groupName: group.name,
        });
    }

    for (const group of allGroups) {
      console.log(`\n  ${group.name}`);
      for (const test of group.tests) {
        const result = allResults.find(
          (r) => r.groupName === group.name && r.name.endsWith(test.name)
        )!;
        console.log(
          `${result.passed ? '  PASS' : '  FAIL'}  ${test.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
        );
      }
    }
  } finally {
    console.log('\nCleaning up...');
    await cleanup();
    console.log('  Agent deleted');
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
