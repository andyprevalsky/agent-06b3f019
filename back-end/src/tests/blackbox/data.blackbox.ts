#!/usr/bin/env tsx
/**
 * Black-box tests for /api/data
 * Usage: npx tsx src/tests/blackbox/data.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

const GrepResponse = z.object({
  matches: z.array(z.object({
    thread: z.string(),
    person: z.object({ firstName: z.string().nullable(), lastName: z.string().nullable(), phoneNumber: z.string().nullable(), email: z.string().nullable() }),
    messages: z.array(z.object({ channel: z.string(), from: z.string(), to: z.string(), timestamp: z.string(), message: z.string(), is_match: z.boolean() })),
  })),
  total_matches: z.number(),
  truncated: z.boolean(),
  pattern: z.string().optional(),
  source: z.string().optional(),
  since: z.string().optional(),
  message: z.string().optional(),
  truncation_message: z.string().optional(),
});

const SummaryResponse = z.object({
  sources: z.object({
    messages: z.object({
      total_threads: z.number(),
      total_messages: z.number(),
      channels: z.record(z.number()),
      date_range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
      threads: z.array(z.object({ name: z.string(), message_count: z.number(), last_message: z.string() })),
    }),
  }),
});

const ErrorResponse = z.object({ error: z.string(), message: z.string().optional() });

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

// POST /grep
async function testGrep_noAuth() { const res = await request(`${BASE_URL}/api/data/grep`, { method: 'POST', body: JSON.stringify({ pattern: 'test' }) }); assertStatus(res.status, 401, res.data); }
async function testGrep_missingPattern() {
  const res = await request(`${BASE_URL}/api/data/grep`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
}
async function testGrep_happy() {
  const res = await request(`${BASE_URL}/api/data/grep`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ pattern: 'test' }) });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep');
}
async function testGrep_emptyPattern() {
  const res = await request(`${BASE_URL}/api/data/grep`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ pattern: '' }) });
  assertStatus(res.status, 200, res.data);
  assertSchema(GrepResponse, res.data, 'POST /grep (empty pattern)');
}
async function testGrep_invalidSource() {
  const res = await request(`${BASE_URL}/api/data/grep`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ pattern: 'test', source: 'nonexistent' }) });
  assertStatus(res.status, 400, res.data);
}

// GET /summary
async function testSummary_noAuth() { const res = await request(`${BASE_URL}/api/data/summary`); assertStatus(res.status, 401, res.data); }
async function testSummary_happy() {
  const res = await request(`${BASE_URL}/api/data/summary`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 200, res.data);
  assertSchema(SummaryResponse, res.data, 'GET /summary');
}
async function testSummary_apiKey() {
  const res = await request(`${BASE_URL}/api/data/summary`, { headers: { ...apiKeyHeaders(), 'X-User-Id': ctx.userId! } });
  assertStatus(res.status, 200, res.data);
  assertSchema(SummaryResponse, res.data, 'GET /summary (API key)');
}

async function runAll() {
  console.log('🧪 Data Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups = [
    { name: 'POST /grep', tests: [{ name: 'no auth → 401', fn: testGrep_noAuth }, { name: 'missing pattern → 400', fn: testGrep_missingPattern }, { name: 'happy path', fn: testGrep_happy }, { name: 'empty pattern (returns all)', fn: testGrep_emptyPattern }, { name: 'invalid source → 400', fn: testGrep_invalidSource }] },
    { name: 'GET /summary', tests: [{ name: 'no auth → 401', fn: testSummary_noAuth }, { name: 'happy path (JWT)', fn: testSummary_happy }, { name: 'happy path (API key)', fn: testSummary_apiKey }] },
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
