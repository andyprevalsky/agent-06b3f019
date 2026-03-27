#!/usr/bin/env tsx
/**
 * Black-box tests for /webhooks
 * Usage: npx tsx src/tests/blackbox/webhooks.blackbox.ts
 *
 * Note: Stripe webhooks require valid signature verification.
 * We can only test that invalid/missing signatures are rejected.
 */
import { config } from 'dotenv';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

interface TestResult { name: string; passed: boolean; error?: string; duration: number; }

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try { await fn(); return { name, passed: true, duration: Date.now() - start }; }
  catch (error) { return { name, passed: false, error: error instanceof Error ? error.message : String(error), duration: Date.now() - start }; }
}

// POST /webhooks/stripe — must reject without valid Stripe signature
async function testStripe_noSignature() {
  const response = await fetch(`${BASE_URL}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'test' }),
  });
  // Without a valid stripe-signature header, should return 400
  if (response.status !== 400) throw new Error(`Expected status 400, got ${response.status}`);
}

async function runAll() {
  console.log('🧪 Webhooks Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'POST /webhooks/stripe', tests: [{ name: 'no signature → 400', fn: testStripe_noSignature }] },
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
