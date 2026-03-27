#!/usr/bin/env tsx
/**
 * Black-box tests for /api/blueprints
 * Usage: npx tsx src/tests/blackbox/blueprints.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

const ErrorResponse = z.object({ error: z.string() });

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

// POST /search
async function testSearch_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints/search`, { method: 'POST', body: JSON.stringify({ goal: 'test' }) });
  assertStatus(res.status, 401, res.data);
}
async function testSearch_missingGoal() {
  const res = await request(`${BASE_URL}/api/blueprints/search`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
}
async function testSearch_emptyResults() {
  const res = await request(`${BASE_URL}/api/blueprints/search`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ goal: 'test' }) });
  assertStatus(res.status, 200, res.data);
  if (!Array.isArray(res.data)) throw new Error('Expected array response');
}

// POST / (create)
async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints`, { method: 'POST', body: JSON.stringify({ title: 'test', blueprint: {} }) });
  assertStatus(res.status, 401, res.data);
}
async function testCreate_missingFields() {
  const res = await request(`${BASE_URL}/api/blueprints`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
}

// GET / (list)
async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints`);
  // No auth middleware on GET /, but checks req.user?.id → returns 401
  assertStatus(res.status, 401, res.data);
}
async function testList_emptyForAnon() {
  const res = await request(`${BASE_URL}/api/blueprints`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 200, res.data);
  if (!Array.isArray(res.data)) throw new Error('Expected array response');
}

// GET /by-goal
async function testByGoal_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints/by-goal?goal=test`);
  assertStatus(res.status, 401, res.data);
}
async function testByGoal_notFound() {
  const res = await request(`${BASE_URL}/api/blueprints/by-goal?goal=nonexistent-goal-${Date.now()}`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 404, res.data);
}

// DELETE /:id
async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent`, { method: 'DELETE' });
  assertStatus(res.status, 401, res.data);
}
async function testDelete_notFound() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent`, { method: 'DELETE', headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 404, res.data);
}

// PATCH /:id/feedback
async function testFeedback_noAuth() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, { method: 'PATCH', body: JSON.stringify({ rating: 5 }) });
  assertStatus(res.status, 401, res.data);
}
async function testFeedback_invalidRating() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, { method: 'PATCH', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ rating: 0 }) });
  assertStatus(res.status, 400, res.data);
}
async function testFeedback_notFound() {
  const res = await request(`${BASE_URL}/api/blueprints/nonexistent/feedback`, { method: 'PATCH', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ rating: 5 }) });
  assertStatus(res.status, 404, res.data);
}

async function runAll() {
  console.log('🧪 Blueprints Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups = [
    { name: 'POST /search', tests: [{ name: 'no auth → 401', fn: testSearch_noAuth }, { name: 'missing goal → 400', fn: testSearch_missingGoal }, { name: 'empty results', fn: testSearch_emptyResults }] },
    { name: 'POST / (create)', tests: [{ name: 'no auth → 401', fn: testCreate_noAuth }, { name: 'missing fields → 400', fn: testCreate_missingFields }] },
    { name: 'GET / (list)', tests: [{ name: 'no auth → 401', fn: testList_noAuth }, { name: 'empty for anon user', fn: testList_emptyForAnon }] },
    { name: 'GET /by-goal', tests: [{ name: 'no auth → 401', fn: testByGoal_noAuth }, { name: 'not found → 404', fn: testByGoal_notFound }] },
    { name: 'DELETE /:id', tests: [{ name: 'no auth → 401', fn: testDelete_noAuth }, { name: 'not found → 404', fn: testDelete_notFound }] },
    { name: 'PATCH /:id/feedback', tests: [{ name: 'no auth → 401', fn: testFeedback_noAuth }, { name: 'invalid rating → 400', fn: testFeedback_invalidRating }, { name: 'not found → 404', fn: testFeedback_notFound }] },
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
