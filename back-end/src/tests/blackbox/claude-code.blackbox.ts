#!/usr/bin/env tsx
/**
 * Black-box tests for /api/claude-code-session
 * Usage: npx tsx src/tests/blackbox/claude-code.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

const ErrorResponse = z.object({ error: z.string() });

interface TestResult { name: string; passed: boolean; error?: string; duration: number; }

async function request(url: string, options: RequestInit = {}): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let data: unknown;
  if (response.headers.get('content-type')?.includes('application/json')) { data = await response.json(); } else { data = await response.text(); }
  return { status: response.status, data, headers: response.headers };
}
function apiKeyHeaders(): Record<string, string> { return { 'X-API-Key': API_KEY }; }
async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try { await fn(); return { name, passed: true, duration: Date.now() - start }; }
  catch (error) { return { name, passed: false, error: error instanceof Error ? error.message : String(error), duration: Date.now() - start }; }
}
function assertStatus(actual: number, expected: number, data: unknown): void { if (actual !== expected) throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`); }

// POST /create
async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, { method: 'POST', body: JSON.stringify({ agent_id: '00000000-0000-0000-0000-000000000000', goal: 'test' }) });
  assertStatus(res.status, 401, res.data);
}
async function testCreate_invalidBody() {
  const res = await request(`${BASE_URL}/api/claude-code-session/create`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({}) });
  assertStatus(res.status, 500, res.data); // Zod parse fails inside try/catch → 500
}

// POST /close
async function testClose_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/close`, { method: 'POST', body: JSON.stringify({ task_id: '00000000-0000-0000-0000-000000000000' }) });
  assertStatus(res.status, 401, res.data);
}

// GET /:taskId
async function testGet_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/nonexistent`);
  assertStatus(res.status, 401, res.data);
}
async function testGet_notFound() {
  const res = await request(`${BASE_URL}/api/claude-code-session/00000000-0000-0000-0000-000000000000`, { headers: apiKeyHeaders() });
  assertStatus(res.status, 404, res.data);
}

// GET /agent/:agentId
async function testGetByAgent_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/nonexistent`);
  assertStatus(res.status, 401, res.data);
}
async function testGetByAgent_empty() {
  const res = await request(`${BASE_URL}/api/claude-code-session/agent/00000000-0000-0000-0000-000000000000`, { headers: apiKeyHeaders() });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { sessions: unknown[] };
  if (!Array.isArray(body.sessions)) throw new Error('Expected sessions array');
}

// POST /:taskId/output
async function testOutput_noAuth() {
  const res = await request(`${BASE_URL}/api/claude-code-session/nonexistent/output`, { method: 'POST', body: JSON.stringify({ output: 'test' }) });
  assertStatus(res.status, 401, res.data);
}
async function testOutput_missingField() {
  const res = await request(`${BASE_URL}/api/claude-code-session/nonexistent/output`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
}

async function runAll() {
  console.log('🧪 Claude Code Session Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'POST /create', tests: [{ name: 'no auth → 401', fn: testCreate_noAuth }, { name: 'invalid body → 500', fn: testCreate_invalidBody }] },
    { name: 'POST /close', tests: [{ name: 'no auth → 401', fn: testClose_noAuth }] },
    { name: 'GET /:taskId', tests: [{ name: 'no auth → 401', fn: testGet_noAuth }, { name: 'not found → 404', fn: testGet_notFound }] },
    { name: 'GET /agent/:agentId', tests: [{ name: 'no auth → 401', fn: testGetByAgent_noAuth }, { name: 'empty sessions → 200', fn: testGetByAgent_empty }] },
    { name: 'POST /:taskId/output', tests: [{ name: 'no auth → 401', fn: testOutput_noAuth }, { name: 'missing output → 400', fn: testOutput_missingField }] },
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
