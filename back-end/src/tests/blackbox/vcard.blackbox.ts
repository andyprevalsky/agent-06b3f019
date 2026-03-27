#!/usr/bin/env tsx
/**
 * Black-box tests for /api/vcard
 * Usage: npx tsx src/tests/blackbox/vcard.blackbox.ts
 */
import { config } from 'dotenv';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

interface TestResult { name: string; passed: boolean; error?: string; duration: number; }

async function request(url: string, options: RequestInit = {}): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, options);
  let data: unknown;
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) { data = await response.json(); } else { data = await response.text(); }
  return { status: response.status, data, headers: response.headers };
}
async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try { await fn(); return { name, passed: true, duration: Date.now() - start }; }
  catch (error) { return { name, passed: false, error: error instanceof Error ? error.message : String(error), duration: Date.now() - start }; }
}
function assertStatus(actual: number, expected: number, data: unknown): void { if (actual !== expected) throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 200)}`); }

// GET /rose.vcf
async function testRoseVcf_happy() {
  const res = await request(`${BASE_URL}/api/vcard/rose.vcf`);
  assertStatus(res.status, 200, res.data);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/vcard')) throw new Error(`Expected content-type text/vcard, got ${ct}`);
  const body = res.data as string;
  if (!body.includes('BEGIN:VCARD')) throw new Error('Response is not a valid vCard');
  if (!body.includes('Rose')) throw new Error('vCard missing Rose name');
}

// GET /:userId.vcf
async function testPersonalVcf_nonexistentUser() {
  const res = await request(`${BASE_URL}/api/vcard/nonexistent-user-id.vcf`);
  // Falls back to default Rose vCard on error
  assertStatus(res.status, 200, res.data);
  const body = res.data as string;
  if (!body.includes('BEGIN:VCARD')) throw new Error('Response is not a valid vCard');
}

async function runAll() {
  console.log('🧪 VCard Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'GET /rose.vcf', tests: [{ name: 'returns valid vCard', fn: testRoseVcf_happy }] },
    { name: 'GET /:userId.vcf', tests: [{ name: 'nonexistent user → fallback vCard', fn: testPersonalVcf_nonexistentUser }] },
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
