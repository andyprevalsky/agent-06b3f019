#!/usr/bin/env tsx
/**
 * Black-box tests for /api/models
 *
 * Usage:
 *   npx tsx src/tests/blackbox/models.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

// ==================== RESPONSE SCHEMAS ====================

const ModelItem = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  description: z.string().optional(),
  contextLength: z.number().optional(),
  pricing: z
    .object({
      prompt: z.string().optional(),
      completion: z.string().optional(),
    })
    .optional(),
});

const ListModelsResponse = z.object({
  models: z.array(ModelItem),
  cached: z.boolean(),
  count: z.number().optional(),
});

const CacheClearedResponse = z.object({
  message: z.string(),
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

// ==================== DELETE /cache ====================

async function testClearCache_happy() {
  const res = await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  assertStatus(res.status, 200, res.data);
  assertSchema(CacheClearedResponse, res.data, 'DELETE /cache');
}

// ==================== GET / (list models) ====================

async function testListModels_happy() {
  await request(`${BASE_URL}/api/models/cache`, { method: 'DELETE' });
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListModelsResponse, res.data, 'GET /');
  if (body.models.length < 2) throw new Error(`Expected at least 2 models, got ${body.models.length}`);
  if (body.models[0].id !== 'rose-labs/rose-1-lite') throw new Error(`Expected first model rose-labs/rose-1-lite, got ${body.models[0].id}`);
  if (body.models[1].id !== 'rose-labs/rose-1-ultra') throw new Error(`Expected second model rose-labs/rose-1-ultra, got ${body.models[1].id}`);
}

async function testListModels_cached() {
  await request(`${BASE_URL}/api/models`);
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListModelsResponse, res.data, 'GET / (cached)');
  if (body.cached !== true) throw new Error(`Expected cached=true, got ${body.cached}`);
}

async function testListModels_roseModelShape() {
  const res = await request(`${BASE_URL}/api/models`);
  assertStatus(res.status, 200, res.data);
  const body = res.data as { models: { id: string; pricing?: { prompt?: string; completion?: string }; contextLength?: number }[] };
  const roseLite = body.models.find((m) => m.id === 'rose-labs/rose-1-lite');
  if (!roseLite) throw new Error('rose-labs/rose-1-lite not found');
  if (!roseLite.pricing || typeof roseLite.pricing.prompt !== 'string' || typeof roseLite.pricing.completion !== 'string') {
    throw new Error(`rose-1-lite missing pricing: ${JSON.stringify(roseLite.pricing)}`);
  }
  if (typeof roseLite.contextLength !== 'number') throw new Error(`rose-1-lite missing contextLength`);
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('🧪 Models Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'DELETE /cache',
      tests: [{ name: 'happy path', fn: testClearCache_happy }],
    },
    {
      name: 'GET / (list models)',
      tests: [
        { name: 'happy path', fn: testListModels_happy },
        { name: 'cached response', fn: testListModels_cached },
        { name: 'Rose model shape', fn: testListModels_roseModelShape },
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
