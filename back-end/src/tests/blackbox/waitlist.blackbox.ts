#!/usr/bin/env tsx
/**
 * Black-box tests for /api/waitlist
 * Usage: npx tsx src/tests/blackbox/waitlist.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

const SuccessResponse = z.object({ success: z.boolean(), message: z.string(), alreadyRegistered: z.boolean() });
const ErrorResponse = z.object({ error: z.string() });

interface TestResult { name: string; passed: boolean; error?: string; duration: number; }

async function request(url: string, options: RequestInit = {}): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let data: unknown;
  if (response.headers.get('content-type')?.includes('application/json')) { data = await response.json(); } else { data = await response.text(); }
  return { status: response.status, data, headers: response.headers };
}
async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try { await fn(); return { name, passed: true, duration: Date.now() - start }; }
  catch (error) { return { name, passed: false, error: error instanceof Error ? error.message : String(error), duration: Date.now() - start }; }
}
function assertStatus(actual: number, expected: number, data: unknown): void { if (actual !== expected) throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`); }
function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T { const result = schema.safeParse(data); if (!result.success) throw new Error(`${label} schema validation failed: ${result.error.message}`); return result.data; }

async function testWaitlist_missingFields() {
  const res = await request(`${BASE_URL}/api/waitlist`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing)');
}
async function testWaitlist_missingEmail() {
  const res = await request(`${BASE_URL}/api/waitlist`, { method: 'POST', body: JSON.stringify({ name: 'Test' }) });
  assertStatus(res.status, 400, res.data);
}
async function testWaitlist_invalidEmail() {
  const res = await request(`${BASE_URL}/api/waitlist`, { method: 'POST', body: JSON.stringify({ name: 'Test', email: 'not-an-email' }) });
  assertStatus(res.status, 400, res.data);
}
async function testWaitlist_happy() {
  const unique = `test-${Date.now()}@contract-test.dev`;
  const res = await request(`${BASE_URL}/api/waitlist`, { method: 'POST', body: JSON.stringify({ name: 'Contract Test', email: unique }) });
  assertStatus(res.status, 200, res.data);
  assertSchema(SuccessResponse, res.data, 'POST / (200)');
}
async function testWaitlist_duplicate() {
  const unique = `dup-${Date.now()}@contract-test.dev`;
  await request(`${BASE_URL}/api/waitlist`, { method: 'POST', body: JSON.stringify({ name: 'Dup Test', email: unique }) });
  const res = await request(`${BASE_URL}/api/waitlist`, { method: 'POST', body: JSON.stringify({ name: 'Dup Test', email: unique }) });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(SuccessResponse, res.data, 'POST / (dup)');
  if (!body.alreadyRegistered) throw new Error('Expected alreadyRegistered to be true');
}

async function runAll() {
  console.log('🧪 Waitlist Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'POST / (join waitlist)', tests: [
      { name: 'missing fields → 400', fn: testWaitlist_missingFields },
      { name: 'missing email → 400', fn: testWaitlist_missingEmail },
      { name: 'invalid email → 400', fn: testWaitlist_invalidEmail },
      { name: 'happy path', fn: testWaitlist_happy },
      { name: 'duplicate → alreadyRegistered', fn: testWaitlist_duplicate },
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
