#!/usr/bin/env tsx
/**
 * Black-box tests for /api/agents
 * Usage: npx tsx src/tests/blackbox/agents.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

const ErrorResponse = z.object({ error: z.string() });

interface TestResult { name: string; passed: boolean; error?: string; duration: number; }
interface TestContext { accessToken?: string; userId?: string; agentId?: string; }
const ctx: TestContext = {};

async function request(url: string, options: RequestInit = {}): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let data: unknown;
  if (response.headers.get('content-type')?.includes('application/json')) { data = await response.json(); } else { data = await response.text(); }
  return { status: response.status, data, headers: response.headers };
}
function authHeaders(token: string): Record<string, string> { return { Authorization: `Bearer ${token}` }; }
function apiKeyHeaders(userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'X-API-Key': API_KEY };
  if (userId) h['X-User-Id'] = userId;
  return h;
}
async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try { await fn(); return { name, passed: true, duration: Date.now() - start }; }
  catch (error) { return { name, passed: false, error: error instanceof Error ? error.message : String(error), duration: Date.now() - start }; }
}
function assertStatus(actual: number, expected: number, data: unknown): void { if (actual !== expected) throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`); }
function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T { const result = schema.safeParse(data); if (!result.success) throw new Error(`${label} schema validation failed: ${result.error.message}`); return result.data; }

async function setupAuth(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token; ctx.userId = d.user.id;
}

const FAKE_AGENT_ID = '00000000-0000-0000-0000-000000000000';

// GET / (list agents)
async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/agents`);
  assertStatus(res.status, 401, res.data);
}
async function testList_happy() {
  const res = await request(`${BASE_URL}/api/agents`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { agents: unknown[] };
  if (!Array.isArray(body.agents)) throw new Error('Expected agents array');
}
async function testList_apiKey() {
  const res = await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(ctx.userId!) });
  assertStatus(res.status, 200, res.data);
}

// GET /tree
async function testTree_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/tree`);
  assertStatus(res.status, 401, res.data);
}

// POST / (create agent)
async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/agents`, { method: 'POST', body: JSON.stringify({ goal: 'test' }) });
  // x402 middleware intercepts no-auth, returns 402 (Payment Required)
  if (res.status !== 401 && res.status !== 402) throw new Error(`Expected 401 or 402, got ${res.status}: ${JSON.stringify(res.data).substring(0, 200)}`);
}
async function testCreate_missingGoal() {
  const res = await request(`${BASE_URL}/api/agents`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data); // Zod parse fails → 400 with details
}
async function testCreate_happy() {
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(ctx.userId!),
    body: JSON.stringify({ goal: 'Black-box test agent - do nothing' }),
  });
  assertStatus(res.status, 201, res.data);
  const body = res.data as any;
  // Response is flat: { agent_id, progress, goal, ... }
  const agentId = body.agent_id;
  if (!agentId) throw new Error(`Missing agent_id in response: ${JSON.stringify(body).substring(0, 300)}`);
  ctx.agentId = agentId;
}

// GET /:id (get agent detail)
async function testGet_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}`);
  assertStatus(res.status, 401, res.data);
}
async function testGet_notFound() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 404, res.data);
}
async function testGet_happy() {
  const res = await request(`${BASE_URL}/api/agents/${ctx.agentId}`, { headers: apiKeyHeaders(ctx.userId!) });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { agent: { agent_id: string; goal: string }; messages: unknown[] };
  if (body.agent.agent_id !== ctx.agentId) throw new Error('Agent ID mismatch');
  if (!Array.isArray(body.messages)) throw new Error('Expected messages array');
}

// GET /:id/ancestors
async function testAncestors_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}/ancestors`);
  assertStatus(res.status, 401, res.data);
}

// POST /:id/messages
async function testMessages_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}/messages`, { method: 'POST', body: JSON.stringify({ message: 'test' }) });
  assertStatus(res.status, 401, res.data);
}
async function testMessages_notFound() {
  // Internal auth requires role to be specified
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}/messages`, { method: 'POST', headers: apiKeyHeaders(ctx.userId!), body: JSON.stringify({ message: 'test', role: 'USER' }) });
  assertStatus(res.status, 404, res.data);
}

// GET /:id/status
async function testStatus_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}/status`);
  assertStatus(res.status, 401, res.data);
}

// POST /:id/start-agent
async function testStartAgent_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}/start-agent`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// PATCH /:id/status
async function testUpdateStatus_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE', progress: 0.5, tokenCount: 0, contextSize: 0, messageCount: 0 }) });
  assertStatus(res.status, 401, res.data);
}

// DELETE /:id
async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}`, { method: 'DELETE' });
  assertStatus(res.status, 401, res.data);
}
async function testDelete_notFound() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}`, { method: 'DELETE', headers: apiKeyHeaders(ctx.userId!) });
  assertStatus(res.status, 404, res.data);
}

// POST /:id/pause
async function testPause_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}/pause`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /:id/resume
async function testResume_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}/resume`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// PATCH /:id (update agent)
async function testUpdate_noAuth() {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_AGENT_ID}`, { method: 'PATCH', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// Cleanup: delete the test agent
async function testCleanup_deleteAgent() {
  if (!ctx.agentId) return;
  const res = await request(`${BASE_URL}/api/agents/${ctx.agentId}`, { method: 'DELETE', headers: apiKeyHeaders(ctx.userId!) });
  // DELETE returns 204 No Content on success
  if (res.status !== 200 && res.status !== 204) throw new Error(`Expected 200 or 204, got ${res.status}: ${JSON.stringify(res.data)}`);
}

async function runAll() {
  console.log('🧪 Agents Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups = [
    { name: 'GET / (list)', tests: [{ name: 'no auth → 401', fn: testList_noAuth }, { name: 'happy path (JWT)', fn: testList_happy }, { name: 'happy path (API key)', fn: testList_apiKey }] },
    { name: 'GET /tree', tests: [{ name: 'no auth → 401', fn: testTree_noAuth }] },
    { name: 'POST / (create)', tests: [{ name: 'no auth → 401', fn: testCreate_noAuth }, { name: 'missing goal → 500', fn: testCreate_missingGoal }, { name: 'happy path', fn: testCreate_happy }] },
    { name: 'GET /:id', tests: [{ name: 'no auth → 401', fn: testGet_noAuth }, { name: 'not found → 404', fn: testGet_notFound }, { name: 'happy path', fn: testGet_happy }] },
    { name: 'GET /:id/ancestors', tests: [{ name: 'no auth → 401', fn: testAncestors_noAuth }] },
    { name: 'POST /:id/messages', tests: [{ name: 'no auth → 401', fn: testMessages_noAuth }, { name: 'not found → 404', fn: testMessages_notFound }] },
    { name: 'GET /:id/status', tests: [{ name: 'no auth → 401', fn: testStatus_noAuth }] },
    { name: 'POST /:id/start-agent', tests: [{ name: 'no auth → 401', fn: testStartAgent_noAuth }] },
    { name: 'PATCH /:id/status', tests: [{ name: 'no auth → 401', fn: testUpdateStatus_noAuth }] },
    { name: 'DELETE /:id', tests: [{ name: 'no auth → 401', fn: testDelete_noAuth }, { name: 'not found → 404', fn: testDelete_notFound }] },
    { name: 'POST /:id/pause', tests: [{ name: 'no auth → 401', fn: testPause_noAuth }] },
    { name: 'POST /:id/resume', tests: [{ name: 'no auth → 401', fn: testResume_noAuth }] },
    { name: 'PATCH /:id (update)', tests: [{ name: 'no auth → 401', fn: testUpdate_noAuth }] },
    { name: 'Cleanup', tests: [{ name: 'delete test agent', fn: testCleanup_deleteAgent }] },
  ];

  const allResults: TestResult[] = [];
  for (const group of groups) {
    console.log(`\n📋 ${group.name}`);
    for (const test of group.tests) {
      const result = await runTest(`${group.name} — ${test.name}`, test.fn);
      allResults.push(result);
      console.log(`  ${result.passed ? '✅' : '❌'} ${test.name}${result.passed ? '' : ` — ${result.error}`} (${result.duration}ms)`);
    }
  }
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${allResults.length} total`);
  if (failed > 0) { console.log('\n❌ FAILURES:'); allResults.filter(r => !r.passed).forEach(r => console.log(`   • ${r.name}: ${r.error}`)); process.exit(1); }
  console.log('\n✅ ALL CONTRACT TESTS PASSED\n'); process.exit(0);
}
runAll().catch(error => { console.error('\n💥 Crashed:', error); process.exit(1); });
