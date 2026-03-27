#!/usr/bin/env tsx
/**
 * Black-box tests for /api/tool-usage
 * Usage: npx tsx src/tests/blackbox/tool-usage.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

const ErrorResponse = z.object({ error: z.string() });
const CreateToolUsageResponse = z.object({ id: z.string(), agent_id: z.string(), tool_name: z.string(), total_cost_cents: z.number(), created_at: z.string().or(z.date()) });
const GetToolUsageResponse = z.object({
  agent_id: z.string(), tool_usage_count: z.number(), total_cost_cents: z.number(), total_cost_dollars: z.number(), total_tokens_from_tools: z.number(),
  usages: z.array(z.object({ id: z.string(), tool_name: z.string(), total_cost_cents: z.number(), usage_items: z.any(), created_at: z.string().or(z.date()) })),
});

interface TestResult { name: string; passed: boolean; error?: string; duration: number; }
interface TestContext { accessToken?: string; userId?: string; }
const ctx: TestContext = {};

async function request(url: string, options: RequestInit = {}): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let data: unknown;
  if (response.headers.get('content-type')?.includes('application/json')) { data = await response.json(); } else { data = await response.text(); }
  return { status: response.status, data, headers: response.headers };
}
function authHeaders(token: string): Record<string, string> { return { Authorization: `Bearer ${token}` }; }
function apiKeyHeaders(): Record<string, string> { return { 'X-API-Key': API_KEY }; }
async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try { await fn(); return { name, passed: true, duration: Date.now() - start }; }
  catch (error) { return { name, passed: false, error: error instanceof Error ? error.message : String(error), duration: Date.now() - start }; }
}
function assertStatus(actual: number, expected: number, data: unknown): void { if (actual !== expected) throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`); }
function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T { const result = schema.safeParse(data); if (!result.success) throw new Error(`${label} schema validation failed: ${result.error.message}`); return result.data; }

async function setupAuth(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token; ctx.userId = d.user.id;
}

const FAKE_AGENT_ID = 'nonexistent-agent-id';

// POST / (create)
async function testCreate_noAuth() { const res = await request(`${BASE_URL}/api/tool-usage`, { method: 'POST', body: JSON.stringify({ agent_id: 'x', user_id: 'x', tool_name: 'test', total_cost_cents: 0, usage_items: [] }) }); assertStatus(res.status, 401, res.data); }
async function testCreate_missingAgentId() {
  const res = await request(`${BASE_URL}/api/tool-usage`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ user_id: ctx.userId, tool_name: 'test', total_cost_cents: 0, usage_items: [] }) });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing agent_id)');
}
async function testCreate_missingToolName() {
  const res = await request(`${BASE_URL}/api/tool-usage`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ agent_id: 'x', user_id: ctx.userId, total_cost_cents: 0, usage_items: [] }) });
  assertStatus(res.status, 400, res.data);
}
async function testCreate_agentNotFound() {
  const res = await request(`${BASE_URL}/api/tool-usage`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ agent_id: FAKE_AGENT_ID, user_id: ctx.userId, tool_name: 'test', total_cost_cents: 0, usage_items: [] }) });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (404)');
}

// GET /:agentId
async function testGet_noAuth() { const res = await request(`${BASE_URL}/api/tool-usage/${FAKE_AGENT_ID}`); assertStatus(res.status, 401, res.data); }
async function testGet_notFound() {
  const res = await request(`${BASE_URL}/api/tool-usage/${FAKE_AGENT_ID}`, { headers: apiKeyHeaders() });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'GET /:agentId (404)');
}

async function runAll() {
  console.log('🧪 Tool Usage Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups = [
    { name: 'POST / (create)', tests: [{ name: 'no auth → 401', fn: testCreate_noAuth }, { name: 'missing agent_id → 400', fn: testCreate_missingAgentId }, { name: 'missing tool_name → 400', fn: testCreate_missingToolName }, { name: 'agent not found → 404', fn: testCreate_agentNotFound }] },
    { name: 'GET /:agentId', tests: [{ name: 'no auth → 401', fn: testGet_noAuth }, { name: 'not found → 404', fn: testGet_notFound }] },
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
