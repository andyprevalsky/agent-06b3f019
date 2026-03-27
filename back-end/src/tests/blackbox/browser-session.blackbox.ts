#!/usr/bin/env tsx
/**
 * Black-box tests for /api/browser-session
 * Usage: npx tsx src/tests/blackbox/browser-session.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

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
function apiKeyHeaders(): Record<string, string> { return { 'X-API-Key': API_KEY }; }
async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try { await fn(); return { name, passed: true, duration: Date.now() - start }; }
  catch (error) { return { name, passed: false, error: error instanceof Error ? error.message : String(error), duration: Date.now() - start }; }
}
function assertStatus(actual: number, expected: number, data: unknown): void { if (actual !== expected) throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`); }

async function setupAuth(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token; ctx.userId = d.user.id;
}

// POST /init
async function testInit_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/init`, { method: 'POST', body: JSON.stringify({ user_id: 'x', agent_id: '00000000-0000-0000-0000-000000000000', start_url: 'https://example.com' }) });
  assertStatus(res.status, 401, res.data);
}
async function testInit_invalidBody() {
  const res = await request(`${BASE_URL}/api/browser-session/init`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({}) });
  assertStatus(res.status, 500, res.data); // Zod parse throws inside try/catch → 500
}

// POST /close
async function testClose_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/close`, { method: 'POST', body: JSON.stringify({ session_id: 'x' }) });
  assertStatus(res.status, 401, res.data);
}

// POST /resume
async function testResume_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/resume`, { method: 'POST', body: JSON.stringify({ task_id: '00000000-0000-0000-0000-000000000000' }) });
  assertStatus(res.status, 401, res.data);
}

// GET /task/:taskId
async function testGetTask_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent`);
  assertStatus(res.status, 401, res.data);
}
async function testGetTask_notFound() {
  const res = await request(`${BASE_URL}/api/browser-session/task/nonexistent`, { headers: apiKeyHeaders() });
  assertStatus(res.status, 404, res.data);
}

// GET /context/:userId
async function testGetContext_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/context/nonexistent`);
  assertStatus(res.status, 401, res.data);
}

// GET /:sessionId
async function testGetSession_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent-session`);
  assertStatus(res.status, 401, res.data);
}
async function testGetSession_notFound() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent-session`, { headers: apiKeyHeaders() });
  assertStatus(res.status, 404, res.data);
}

// GET /:sessionId/files/list
async function testListFiles_noAuth() {
  const res = await request(`${BASE_URL}/api/browser-session/nonexistent/files/list`);
  assertStatus(res.status, 401, res.data);
}

async function runAll() {
  console.log('🧪 Browser Session Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups = [
    { name: 'POST /init', tests: [{ name: 'no auth → 401', fn: testInit_noAuth }, { name: 'invalid body → 500', fn: testInit_invalidBody }] },
    { name: 'POST /close', tests: [{ name: 'no auth → 401', fn: testClose_noAuth }] },
    { name: 'POST /resume', tests: [{ name: 'no auth → 401', fn: testResume_noAuth }] },
    { name: 'GET /task/:taskId', tests: [{ name: 'no auth → 401', fn: testGetTask_noAuth }, { name: 'not found → 404', fn: testGetTask_notFound }] },
    { name: 'GET /context/:userId', tests: [{ name: 'no auth → 401', fn: testGetContext_noAuth }] },
    { name: 'GET /:sessionId', tests: [{ name: 'no auth → 401', fn: testGetSession_noAuth }, { name: 'not found → 404', fn: testGetSession_notFound }] },
    { name: 'GET /:sessionId/files/list', tests: [{ name: 'no auth → 401', fn: testListFiles_noAuth }] },
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
