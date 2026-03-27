#!/usr/bin/env tsx
/**
 * Black-box tests for /api/tools
 *
 * Usage:
 *   npx tsx src/tests/blackbox/tools.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

// ==================== RESPONSE SCHEMAS ====================

const ToolItem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

const ListToolsResponse = z.object({
  tools: z.array(ToolItem),
});

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data: unknown;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data, headers: response.headers };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return { name, passed: false, error: error instanceof Error ? error.message : String(error), duration: Date.now() - start };
  }
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`);
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`${label} schema validation failed: ${result.error.message}`);
  return result.data;
}

// ==================== GET / (list tools) ====================

async function testListTools_happy() {
  const res = await request(`${BASE_URL}/api/tools`);
  assertStatus(res.status, 200, res.data);
  assertSchema(ListToolsResponse, res.data, 'GET /');
}

async function testListTools_sortedByName() {
  const res = await request(`${BASE_URL}/api/tools`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { tools: { name: string }[] };
  for (let i = 1; i < body.tools.length; i++) {
    if (body.tools[i].name.localeCompare(body.tools[i - 1].name) < 0) {
      throw new Error(`Tools not sorted: "${body.tools[i - 1].name}" before "${body.tools[i].name}"`);
    }
  }
}

async function testListTools_itemShape() {
  const res = await request(`${BASE_URL}/api/tools`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { tools: Record<string, unknown>[] };
  if (body.tools.length === 0) return; // empty in dev, skip shape check
  const keys = Object.keys(body.tools[0]).sort();
  const expectedKeys = ['description', 'id', 'name'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Tool has unexpected keys: ${JSON.stringify(keys)}, expected ${JSON.stringify(expectedKeys)}`);
  }
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('🧪 Tools Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'GET / (list tools)',
      tests: [
        { name: 'happy path', fn: testListTools_happy },
        { name: 'sorted by name', fn: testListTools_sortedByName },
        { name: 'item shape (no extra fields)', fn: testListTools_itemShape },
      ],
    },
  ];

  const allResults: TestResult[] = [];
  for (const group of groups) {
    console.log(`\n📋 ${group.name}`);
    for (const test of group.tests) {
      const result = await runTest(`${group.name} — ${test.name}`, test.fn);
      allResults.push(result);
      const icon = result.passed ? '  ✅' : '  ❌';
      console.log(`${icon} ${test.name}${result.passed ? '' : ` — ${result.error}`} (${result.duration}ms)`);
    }
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${allResults.length} total`);
  if (failed > 0) {
    console.log('\n❌ FAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   • ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\n✅ ALL CONTRACT TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => { console.error('\n💥 Black-box test suite crashed:', error); process.exit(1); });
