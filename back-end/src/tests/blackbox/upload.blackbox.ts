#!/usr/bin/env tsx
/**
 * Black-box tests for /api/upload
 * Usage: npx tsx src/tests/blackbox/upload.blackbox.ts
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

async function setupAuth(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token; ctx.userId = d.user.id;
}

// POST / (upload)
async function testUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}
async function testUpload_noFile() {
  // Send POST with auth but no file (multipart expected)
  const res = await request(`${BASE_URL}/api/upload`, { method: 'POST', headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 400, res.data);
}

// GET /:fileId/url
async function testGetUrl_noAuth() {
  const res = await request(`${BASE_URL}/api/upload/some-file-id/url?storage_path=test`);
  assertStatus(res.status, 401, res.data);
}
async function testGetUrl_missingStoragePath() {
  const res = await request(`${BASE_URL}/api/upload/some-file-id/url`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 400, res.data);
}
async function testGetUrl_wrongUser() {
  const res = await request(`${BASE_URL}/api/upload/some-file-id/url?storage_path=other-user/file.txt`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 403, res.data);
}

async function runAll() {
  console.log('🧪 Upload Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups = [
    { name: 'POST / (upload)', tests: [{ name: 'no auth → 401', fn: testUpload_noAuth }, { name: 'no file → 400', fn: testUpload_noFile }] },
    { name: 'GET /:fileId/url', tests: [{ name: 'no auth → 401', fn: testGetUrl_noAuth }, { name: 'missing storage_path → 400', fn: testGetUrl_missingStoragePath }, { name: 'wrong user → 403', fn: testGetUrl_wrongUser }] },
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
