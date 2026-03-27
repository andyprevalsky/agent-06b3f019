#!/usr/bin/env tsx
/**
 * Black-box tests for /api/invite-codes
 * Usage: npx tsx src/tests/blackbox/invite-codes.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

const ErrorResponse = z.object({ error: z.string() });
const MyCodeResponse = z.object({ inviteCode: z.number(), uses: z.number(), usesRemaining: z.number() });
const UseCodeResponse = z.object({ success: z.boolean(), message: z.string() });
const CheckResponse = z.object({ needsInviteCode: z.boolean() });

interface TestResult { name: string; passed: boolean; error?: string; duration: number; }
interface TestContext { accessToken?: string; userId?: string; accessToken2?: string; userId2?: string; }
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
  const res1 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res1.status, 200, res1.data);
  const d1 = res1.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = d1.session.access_token; ctx.userId = d1.user.id;
  const res2 = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res2.status, 200, res2.data);
  const d2 = res2.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken2 = d2.session.access_token; ctx.userId2 = d2.user.id;
}

// GET /my-code
async function testMyCode_happy() {
  const res = await request(`${BASE_URL}/api/invite-codes/my-code`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 200, res.data);
  assertSchema(MyCodeResponse, res.data, 'GET /my-code');
}
async function testMyCode_noAuth() { const res = await request(`${BASE_URL}/api/invite-codes/my-code`); assertStatus(res.status, 401, res.data); }

// POST /use
async function testUse_noAuth() { const res = await request(`${BASE_URL}/api/invite-codes/use`, { method: 'POST', body: JSON.stringify({ inviteCode: 123456 }) }); assertStatus(res.status, 401, res.data); }
async function testUse_missingCode() {
  const res = await request(`${BASE_URL}/api/invite-codes/use`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /use (400)');
}
async function testUse_invalidCode() {
  const res = await request(`${BASE_URL}/api/invite-codes/use`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ inviteCode: 'not-a-number' }) });
  assertStatus(res.status, 400, res.data);
}
async function testUse_notFoundCode() {
  const res = await request(`${BASE_URL}/api/invite-codes/use`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ inviteCode: 999999 }) });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /use (404)');
}

// GET /check
async function testCheck_happy() {
  const res = await request(`${BASE_URL}/api/invite-codes/check`, { headers: authHeaders(ctx.accessToken!) });
  assertStatus(res.status, 200, res.data);
  assertSchema(CheckResponse, res.data, 'GET /check');
}
async function testCheck_noAuth() { const res = await request(`${BASE_URL}/api/invite-codes/check`); assertStatus(res.status, 401, res.data); }

async function runAll() {
  console.log('🧪 Invite Codes Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User 1: ${ctx.userId}\n   User 2: ${ctx.userId2}\n`);

  const groups = [
    { name: 'GET /my-code', tests: [{ name: 'happy path', fn: testMyCode_happy }, { name: 'no auth → 401', fn: testMyCode_noAuth }] },
    { name: 'POST /use', tests: [{ name: 'no auth → 401', fn: testUse_noAuth }, { name: 'missing code → 400', fn: testUse_missingCode }, { name: 'invalid code type → 400', fn: testUse_invalidCode }, { name: 'not found code → 404', fn: testUse_notFoundCode }] },
    { name: 'GET /check', tests: [{ name: 'happy path', fn: testCheck_happy }, { name: 'no auth → 401', fn: testCheck_noAuth }] },
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
