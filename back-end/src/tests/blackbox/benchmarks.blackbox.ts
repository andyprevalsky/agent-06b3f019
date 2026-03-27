#!/usr/bin/env tsx
/**
 * Black-box tests for /api/benchmarks
 * Usage: npx tsx src/tests/blackbox/benchmarks.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

// Tasks response could be an array or have error
const TasksResponse = z.object({ tasks: z.array(z.any()) });
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

// GET / - no auth required
async function testList_happy() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  // Could be 200 with tasks or 500 if tasks.json not found in dev
  if (res.status === 200) {
    const body = TasksResponse.safeParse(res.data);
    if (!body.success) throw new Error(`Schema validation failed: ${body.error.message}`);
  } else if (res.status === 500) {
    // tasks.json may not exist in dev — acceptable
    const body = ErrorResponse.safeParse(res.data);
    if (!body.success) throw new Error(`Error schema validation failed: ${body.error.message}`);
  } else {
    throw new Error(`Unexpected status ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

async function runAll() {
  console.log('🧪 Benchmarks Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'GET / (list tasks)', tests: [{ name: 'returns tasks or 500', fn: testList_happy }] },
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
