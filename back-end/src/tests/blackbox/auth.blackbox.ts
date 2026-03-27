#!/usr/bin/env tsx
/**
 * Black-box tests for /api/auth
 * Usage: npx tsx src/tests/blackbox/auth.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

const AnonymousResponse = z.object({
  success: z.boolean(),
  user: z.object({ id: z.string(), is_anonymous: z.boolean() }),
  session: z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number(), expires_at: z.number(), token_type: z.string() }),
});
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

// POST /anonymous
async function testAnonymous_happy() {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(AnonymousResponse, res.data, 'POST /anonymous');
  if (!body.user.is_anonymous) throw new Error('Expected is_anonymous to be true');
  ctx.accessToken = body.session.access_token;
  ctx.userId = body.user.id;
}

// POST /send-otp
async function testSendOtp_missingPhone() {
  const res = await request(`${BASE_URL}/api/auth/send-otp`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /send-otp (400)');
}

// POST /verify-otp
async function testVerifyOtp_missingFields() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /verify-otp (400)');
}
async function testVerifyOtp_missingToken() {
  const res = await request(`${BASE_URL}/api/auth/verify-otp`, { method: 'POST', body: JSON.stringify({ phone: '+10000000000' }) });
  assertStatus(res.status, 400, res.data);
}

// POST /complete-onboarding
async function testCompleteOnboarding_noAuth() {
  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}
async function testCompleteOnboarding_anonUser() {
  // Anonymous users should get 404 (user not found in DB with auth middleware, or user exists and succeeds)
  const res = await request(`${BASE_URL}/api/auth/complete-onboarding`, { method: 'POST', headers: authHeaders(ctx.accessToken!) });
  // Anonymous user exists in DB, so this should succeed
  if (res.status !== 200) throw new Error(`Expected status 200, got ${res.status}: ${JSON.stringify(res.data)}`);
}

async function runAll() {
  console.log('🧪 Auth Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'POST /anonymous', tests: [{ name: 'happy path', fn: testAnonymous_happy }] },
    { name: 'POST /send-otp', tests: [{ name: 'missing phone → 400', fn: testSendOtp_missingPhone }] },
    { name: 'POST /verify-otp', tests: [{ name: 'missing fields → 400', fn: testVerifyOtp_missingFields }, { name: 'missing token → 400', fn: testVerifyOtp_missingToken }] },
    { name: 'POST /complete-onboarding', tests: [{ name: 'no auth → 401', fn: testCompleteOnboarding_noAuth }, { name: 'anon user → 200', fn: testCompleteOnboarding_anonUser }] },
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
