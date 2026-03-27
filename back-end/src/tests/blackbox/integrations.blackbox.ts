#!/usr/bin/env tsx
/**
 * Black-box tests for /api/integrations
 * Usage: npx tsx src/tests/blackbox/integrations.blackbox.ts
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
function assertStatus(actual: number, expected: number, data: unknown): void { if (actual !== expected) throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`); }

async function setupAuth(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const d = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d.session.access_token; ctx.userId = d.user.id;
}

// GET / (list integrations)
async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations`);
  assertStatus(res.status, 401, res.data);
}
async function testList_happy() {
  const res = await request(`${BASE_URL}/api/integrations`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { integrations: unknown[]; count: number; authenticatedDomains: string[] };
  if (!Array.isArray(body.integrations)) throw new Error('Expected integrations array');
  if (typeof body.count !== 'number') throw new Error('Expected count number');
  if (!Array.isArray(body.authenticatedDomains)) throw new Error('Expected authenticatedDomains array');
}

// POST / (create integration)
async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations`, { method: 'POST', body: JSON.stringify({ name: 'test', type: 'API' }) });
  assertStatus(res.status, 401, res.data);
}

// POST /upload (generic upload)
async function testUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /linkedin/upload
async function testLinkedinUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/linkedin/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /contacts/upload
async function testContactsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/contacts/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /email/upload
async function testEmailUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /email/:provider/start
async function testEmailStart_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /imessage/upload
async function testImessageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// POST /whatsapp/upload
async function testWhatsappUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/upload`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// POST /telegram/connect
async function testTelegramConnect_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/connect`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// POST /telegram/upload
async function testTelegramUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/upload`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// POST /cookies/upload
async function testCookiesUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /localStorage/upload
async function testLocalStorageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /indexedDB/upload
async function testIndexedDBUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /fingerprint/upload
async function testFingerprintUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /permissions/upload
async function testPermissionsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /cacheStorage/upload
async function testCacheStorageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /passwords/upload
async function testPasswordsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// GET /email/messages
async function testEmailMessages_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/messages`);
  assertStatus(res.status, 401, res.data);
}

// POST /email/send
async function testEmailSend_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// PATCH /:name
async function testPatch_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/test`, { method: 'PATCH', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// DELETE /:name
async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/test`, { method: 'DELETE' });
  assertStatus(res.status, 401, res.data);
}

// POST /passwords/apple/upload
async function testApplePasswordsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/apple/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

// POST /passwords/request
async function testPasswordsRequest_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// POST /claude-code/credentials/upload
async function testClaudeCodeCredentials_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// GET /claude-code/credentials/token
async function testClaudeCodeToken_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`);
  assertStatus(res.status, 401, res.data);
}

// POST /claude-code/token/rate-limited
async function testClaudeCodeRateLimited_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

// POST /claude-code/pool-token/rate-limited
async function testClaudeCodePoolRateLimited_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 401, res.data);
}

async function runAll() {
  console.log('🧪 Integrations Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups = [
    { name: 'GET / (list)', tests: [{ name: 'no auth → 401', fn: testList_noAuth }, { name: 'happy path', fn: testList_happy }] },
    { name: 'POST / (create)', tests: [{ name: 'no auth → 401', fn: testCreate_noAuth }] },
    { name: 'Upload endpoints (no auth)', tests: [
      { name: 'POST /upload → 401', fn: testUpload_noAuth },
      { name: 'POST /linkedin/upload → 401', fn: testLinkedinUpload_noAuth },
      { name: 'POST /contacts/upload → 401', fn: testContactsUpload_noAuth },
      { name: 'POST /email/upload → 401', fn: testEmailUpload_noAuth },
      { name: 'POST /imessage/upload → 401', fn: testImessageUpload_noAuth },
      { name: 'POST /whatsapp/upload → 401', fn: testWhatsappUpload_noAuth },
      { name: 'POST /telegram/connect → 401', fn: testTelegramConnect_noAuth },
      { name: 'POST /telegram/upload → 401', fn: testTelegramUpload_noAuth },
      { name: 'POST /cookies/upload → 401', fn: testCookiesUpload_noAuth },
      { name: 'POST /localStorage/upload → 401', fn: testLocalStorageUpload_noAuth },
      { name: 'POST /indexedDB/upload → 401', fn: testIndexedDBUpload_noAuth },
      { name: 'POST /fingerprint/upload → 401', fn: testFingerprintUpload_noAuth },
      { name: 'POST /permissions/upload → 401', fn: testPermissionsUpload_noAuth },
      { name: 'POST /cacheStorage/upload → 401', fn: testCacheStorageUpload_noAuth },
      { name: 'POST /passwords/upload → 401', fn: testPasswordsUpload_noAuth },
      { name: 'POST /passwords/apple/upload → 401', fn: testApplePasswordsUpload_noAuth },
    ] },
    { name: 'Email endpoints', tests: [
      { name: 'POST /email/:provider/start → 401', fn: testEmailStart_noAuth },
      { name: 'GET /email/messages → 401', fn: testEmailMessages_noAuth },
      { name: 'POST /email/send → 401', fn: testEmailSend_noAuth },
    ] },
    { name: 'CRUD endpoints', tests: [
      { name: 'PATCH /:name → 401', fn: testPatch_noAuth },
      { name: 'DELETE /:name → 401', fn: testDelete_noAuth },
    ] },
    { name: 'Password/credential endpoints', tests: [
      { name: 'POST /passwords/request → 401', fn: testPasswordsRequest_noAuth },
      { name: 'POST /claude-code/credentials/upload → 401', fn: testClaudeCodeCredentials_noAuth },
      { name: 'GET /claude-code/credentials/token → 401', fn: testClaudeCodeToken_noAuth },
      { name: 'POST /claude-code/token/rate-limited → 401', fn: testClaudeCodeRateLimited_noAuth },
      { name: 'POST /claude-code/pool-token/rate-limited → 401', fn: testClaudeCodePoolRateLimited_noAuth },
    ] },
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
