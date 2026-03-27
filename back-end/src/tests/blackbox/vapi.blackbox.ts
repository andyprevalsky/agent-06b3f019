#!/usr/bin/env tsx
/**
 * Black-box tests for /api/vapi
 * Usage: npx tsx src/tests/blackbox/vapi.blackbox.ts
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

// POST /call
async function testCall_noAuth() {
  const res = await request(`${BASE_URL}/api/vapi/call`, { method: 'POST', body: JSON.stringify({ to: '+10000000000', system_prompt: 'test', output_schema: {} }) });
  assertStatus(res.status, 401, res.data);
}
async function testCall_missingTo() {
  const res = await request(`${BASE_URL}/api/vapi/call`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ system_prompt: 'test', output_schema: {} }) });
  assertStatus(res.status, 400, res.data);
}
async function testCall_missingPrompt() {
  const res = await request(`${BASE_URL}/api/vapi/call`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ to: '+10000000000', output_schema: {} }) });
  assertStatus(res.status, 400, res.data);
}
async function testCall_missingSchema() {
  const res = await request(`${BASE_URL}/api/vapi/call`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ to: '+10000000000', system_prompt: 'test' }) });
  assertStatus(res.status, 400, res.data);
}

// GET /call/:id
async function testGetCall_noAuth() {
  const res = await request(`${BASE_URL}/api/vapi/call/nonexistent`);
  assertStatus(res.status, 401, res.data);
}

async function runAll() {
  console.log('🧪 Vapi Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'POST /call', tests: [
      { name: 'no auth → 401', fn: testCall_noAuth },
      { name: 'missing to → 400', fn: testCall_missingTo },
      { name: 'missing system_prompt → 400', fn: testCall_missingPrompt },
      { name: 'missing output_schema → 400', fn: testCall_missingSchema },
    ] },
    { name: 'GET /call/:id', tests: [{ name: 'no auth → 401', fn: testGetCall_noAuth }] },
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
