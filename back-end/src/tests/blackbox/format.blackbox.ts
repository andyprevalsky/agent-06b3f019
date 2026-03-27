#!/usr/bin/env tsx
/**
 * Black-box tests for /api/generate-llm-judge-prompt (format router)
 *
 * Usage:
 *   npx tsx src/tests/blackbox/format.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

// ==================== RESPONSE SCHEMAS ====================

const ErrorResponse = z.object({
  error: z.string(),
  details: z.union([z.array(z.any()), z.string()]).optional(),
  hasOpenRouterKey: z.boolean().optional(),
});

const GeneratePromptResponse = z.object({
  prompt: z.string(),
});

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface TestContext {
  accessToken?: string;
  userId?: string;
}

const ctx: TestContext = {};

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

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
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

// ==================== SETUP ====================

async function setupAuth(): Promise<void> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  assertStatus(res.status, 200, res.data);
  const data = res.data as { session: { access_token: string }; user: { id: string } };
  ctx.accessToken = data.session.access_token;
  ctx.userId = data.user.id;
}

// ==================== POST /generate-llm-judge-prompt ====================

async function testGenerate_noAuth() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    body: JSON.stringify({ goal: 'Test goal' }),
  });
  assertStatus(res.status, 401, res.data);
}

async function testGenerate_emptyBody() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 empty body)');
}

async function testGenerate_emptyGoal() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: '' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 empty goal)');
}

async function testGenerate_missingGoal() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ notGoal: 'something' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'POST / (400 missing goal)');
}

async function testGenerate_happy() {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken!),
    body: JSON.stringify({ goal: 'Book a restaurant reservation for Friday night' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(GeneratePromptResponse, res.data, 'POST / (happy)');
  if (!body.prompt || body.prompt.length === 0) throw new Error('Expected non-empty prompt string');
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('🧪 Format (generate-llm-judge-prompt) Contract Tests\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  console.log('🔐 Setting up auth...');
  await setupAuth();
  console.log(`   User: ${ctx.userId}\n`);

  const groups: { name: string; tests: { name: string; fn: () => Promise<void> }[] }[] = [
    {
      name: 'POST /generate-llm-judge-prompt',
      tests: [
        { name: 'no auth → 401', fn: testGenerate_noAuth },
        { name: 'empty body → 400', fn: testGenerate_emptyBody },
        { name: 'empty goal string → 400', fn: testGenerate_emptyGoal },
        { name: 'missing goal field → 400', fn: testGenerate_missingGoal },
        { name: 'happy path', fn: testGenerate_happy },
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
