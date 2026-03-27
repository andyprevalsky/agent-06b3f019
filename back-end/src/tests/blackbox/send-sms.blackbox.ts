#!/usr/bin/env tsx
/**
 * Black-box tests for /api/send-sms
 * Usage: npx tsx src/tests/blackbox/send-sms.blackbox.ts
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

// POST / (send SMS)
async function testSend_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms`, { method: 'POST', body: JSON.stringify({ phone_number: '+10000000000', message: 'test' }) });
  assertStatus(res.status, 401, res.data);
}
async function testSend_missingPhone() {
  const res = await request(`${BASE_URL}/api/send-sms`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ message: 'test' }) });
  assertStatus(res.status, 400, res.data);
}
async function testSend_missingMessage() {
  const res = await request(`${BASE_URL}/api/send-sms`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ phone_number: '+10000000000' }) });
  assertStatus(res.status, 400, res.data);
}

// POST /direct
async function testDirect_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, { method: 'POST', body: JSON.stringify({ user_id: 'x', message: 'test' }) });
  assertStatus(res.status, 401, res.data);
}
async function testDirect_missingFields() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
}

// POST /notify
async function testNotify_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, { method: 'POST', body: JSON.stringify({ user_id: 'x', event_type: 'completion', agent_id: 'x' }) });
  assertStatus(res.status, 401, res.data);
}
async function testNotify_badBody() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
}
async function testNotify_invalidEventType() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ user_id: 'x', event_type: 'invalid_event', agent_id: 'x' }) });
  assertStatus(res.status, 400, res.data);
}

async function runAll() {
  console.log('🧪 Send SMS Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'POST / (send)', tests: [{ name: 'no auth → 401', fn: testSend_noAuth }, { name: 'missing phone → 400', fn: testSend_missingPhone }, { name: 'missing message → 400', fn: testSend_missingMessage }] },
    { name: 'POST /direct', tests: [{ name: 'no auth → 401', fn: testDirect_noAuth }, { name: 'missing fields → 400', fn: testDirect_missingFields }] },
    { name: 'POST /notify', tests: [{ name: 'no auth → 401', fn: testNotify_noAuth }, { name: 'bad body → 400', fn: testNotify_badBody }, { name: 'invalid event type → 400', fn: testNotify_invalidEventType }] },
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
