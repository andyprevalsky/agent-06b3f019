#!/usr/bin/env tsx
/**
 * Black-box tests for /api/memory
 * Usage: npx tsx src/tests/blackbox/memory.blackbox.ts
 */
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

const MemoryEntry = z.object({ timestamp: z.string(), type: z.string(), message_id: z.string().optional(), content: z.string(), files: z.array(z.object({ original_filename: z.string(), mime_type: z.string() })).optional() });
const GetMemoryResponse = z.object({ content: z.array(MemoryEntry), hash: z.string() });
const AppendResponse = z.object({ hash: z.string() });
const ErrorResponse = z.object({ error: z.string(), details: z.any().optional() });

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
function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T { const result = schema.safeParse(data); if (!result.success) throw new Error(`${label} schema validation failed: ${result.error.message}`); return result.data; }

const TEST_BUS_ID = `test-bus-${Date.now()}`;

// GET /:busId
async function testGet_noAuth() { const res = await request(`${BASE_URL}/api/memory/${TEST_BUS_ID}`); assertStatus(res.status, 401, res.data); }
async function testGet_emptyMemory() {
  const res = await request(`${BASE_URL}/api/memory/${TEST_BUS_ID}`, { headers: apiKeyHeaders() });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetMemoryResponse, res.data, 'GET /:busId');
  if (body.content.length !== 0) throw new Error(`Expected empty content, got ${body.content.length}`);
}
async function testGet_304WithHash() {
  const res1 = await request(`${BASE_URL}/api/memory/${TEST_BUS_ID}`, { headers: apiKeyHeaders() });
  const hash = (res1.data as { hash: string }).hash;
  const res2 = await request(`${BASE_URL}/api/memory/${TEST_BUS_ID}?hash=${hash}`, { headers: apiKeyHeaders() });
  assertStatus(res2.status, 304, res2.data);
}

// POST /:busId/append
async function testAppend_noAuth() { const res = await request(`${BASE_URL}/api/memory/${TEST_BUS_ID}/append`, { method: 'POST', body: JSON.stringify({ entry: { type: 'test', content: 'hello' } }) }); assertStatus(res.status, 401, res.data); }
async function testAppend_happy() {
  const res = await request(`${BASE_URL}/api/memory/${TEST_BUS_ID}/append`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ entry: { type: 'test', content: 'hello world' } }) });
  assertStatus(res.status, 200, res.data);
  assertSchema(AppendResponse, res.data, 'POST /:busId/append');
}
async function testAppend_badBody() {
  const res = await request(`${BASE_URL}/api/memory/${TEST_BUS_ID}/append`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({}) });
  assertStatus(res.status, 400, res.data);
}
async function testAppend_thenGet() {
  const busId = `test-bus-verify-${Date.now()}`;
  await request(`${BASE_URL}/api/memory/${busId}/append`, { method: 'POST', headers: apiKeyHeaders(), body: JSON.stringify({ entry: { type: 'note', content: 'verify content' } }) });
  const res = await request(`${BASE_URL}/api/memory/${busId}`, { headers: apiKeyHeaders() });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GetMemoryResponse, res.data, 'GET after append');
  if (body.content.length !== 1) throw new Error(`Expected 1 entry, got ${body.content.length}`);
  if (body.content[0].content !== 'verify content') throw new Error(`Wrong content: ${body.content[0].content}`);
}

async function runAll() {
  console.log('🧪 Memory Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups = [
    { name: 'GET /:busId', tests: [{ name: 'no auth → 401', fn: testGet_noAuth }, { name: 'empty memory', fn: testGet_emptyMemory }, { name: '304 with matching hash', fn: testGet_304WithHash }] },
    { name: 'POST /:busId/append', tests: [{ name: 'no auth → 401', fn: testAppend_noAuth }, { name: 'happy path', fn: testAppend_happy }, { name: 'bad body → 400', fn: testAppend_badBody }, { name: 'append then get', fn: testAppend_thenGet }] },
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
