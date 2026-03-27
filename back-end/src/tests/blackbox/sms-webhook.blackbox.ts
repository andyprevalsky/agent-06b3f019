#!/usr/bin/env tsx
/**
 * Black-box tests for /api/sms/inbound (Surge webhook)
 * Usage: npx tsx src/tests/blackbox/sms-webhook.blackbox.ts
 *
 * Note: In production, Surge signature validation is enforced.
 * In dev, signature validation is skipped so we can test the parsing logic.
 */
import { config } from 'dotenv';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

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

// POST /inbound — invalid payload (no from phone or body)
async function testInbound_invalidPayload() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, { method: 'POST', body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
}

// POST /inbound — unknown phone number → 200 (sends "unknown" SMS, returns ok)
async function testInbound_unknownPhone() {
  const res = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        body: 'Hello',
        conversation: {
          contact: { phone_number: '+10000000000' },
          phone_number: { number: '+14154498072' },
        },
      },
    }),
  });
  // Returns 200 with { ok: true } even for unknown phone (sends SMS reply async)
  assertStatus(res.status, 200, res.data);
}

async function runAll() {
  console.log('🧪 SMS Webhook Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'POST /inbound', tests: [
      { name: 'invalid payload → 400', fn: testInbound_invalidPayload },
      { name: 'unknown phone → 200', fn: testInbound_unknownPhone },
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
