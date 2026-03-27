#!/usr/bin/env tsx
/**
 * Black-box tests for /api/feedback
 * Usage: npx tsx src/tests/blackbox/feedback.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

const SuccessResponse = z.object({ success: z.boolean() });
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

async function testFeedback_noAuth() { const res = await request(`${BASE_URL}/api/feedback`, { method: 'POST', body: JSON.stringify({ feedback: 'test' }) }); assertStatus(res.status, 401, res.data); }
async function testFeedback_happy() {
  const res = await request(`${BASE_URL}/api/feedback`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ feedback: 'Great product!' }) });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST /feedback');
}
async function testFeedback_missingFeedback() {
  const res = await request(`${BASE_URL}/api/feedback`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST /feedback (400)');
}
async function testFeedback_emptyString() {
  const res = await request(`${BASE_URL}/api/feedback`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ feedback: '' }) });
  assertStatus(res.status, 400, res.data);
}
async function testFeedback_whitespaceOnly() {
  const res = await request(`${BASE_URL}/api/feedback`, { method: 'POST', headers: authHeaders(ctx.accessToken!), body: JSON.stringify({ feedback: '   ' }) });
  assertStatus(res.status, 400, res.data);
}

async function runAll() {
  console.log('🧪 Feedback Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);
  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups = [
    { name: 'POST / (submit feedback)', tests: [{ name: 'no auth → 401', fn: testFeedback_noAuth }, { name: 'happy path', fn: testFeedback_happy }, { name: 'missing feedback → 400', fn: testFeedback_missingFeedback }, { name: 'empty string → 400', fn: testFeedback_emptyString }, { name: 'whitespace only → 400', fn: testFeedback_whitespaceOnly }] },
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
