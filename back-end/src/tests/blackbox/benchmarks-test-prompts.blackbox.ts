#!/usr/bin/env tsx
/**
 * Black-box tests for /api/benchmarks/test-prompts
 *
 * Domain surface:
 *   GET /api/benchmarks/test-prompts — public, no auth. Adapts the unified eval
 *   catalog (agents/benchmarks/tasks.json) into the shape the front-end
 *   test-prompts picker consumes, so the dev query box can never drift from
 *   the eval suite.
 *
 * Invariants covered:
 *   - contract: response schema, 200-or-500 error surface
 *   - drift guard: payload matches the agent-runner catalog entries 1:1 (count, titles, order)
 *   - filtering: external vitest smokes are excluded
 *   - adaptation: attachment urls live under /test-assets/, {frontend_url} token rewritten
 *   - dev default: the FE auto-load title exists in the catalog
 *   - idempotency: cached at startup, identical across requests
 *
 * Invariants not applicable:
 *   - read-after-write / state transition / atomicity / referential integrity:
 *     read-only stateless endpoint over a startup-cached file
 *   - tenant isolation: public endpoint, no user scoping
 *
 * Usage:
 *   npx tsx src/tests/blackbox/benchmarks-test-prompts.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

// ==================== RESPONSE SCHEMAS ====================

const TestPromptSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  attachmentUrls: z.array(z.string().min(1)),
  tags: z.array(z.string().min(1)),
});

const TestPromptsResponseSchema = z.object({
  prompts: z.array(TestPromptSchema),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
});

type TestPrompt = z.infer<typeof TestPromptSchema>;

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
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  return result.data;
}

// ==================== CONTRACT TESTS ====================

async function testPrompts_happy() {
  const res = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res.status === 200) {
    assertSchema(TestPromptsResponseSchema, res.data, 'GET /api/benchmarks/test-prompts');
  } else if (res.status === 500) {
    assertSchema(ErrorResponseSchema, res.data, 'GET /api/benchmarks/test-prompts (error)');
  } else {
    throw new Error(
      `Unexpected status ${res.status}: ${JSON.stringify(res.data).substring(0, 300)}`
    );
  }
}

async function testPrompts_matchAgentCatalogEntries() {
  // Drift guard: the picker payload must be exactly the agent-runner catalog
  // entries — same count, same titles, same order.
  const tasksRes = await request(`${BASE_URL}/api/benchmarks`);
  const promptsRes = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (tasksRes.status !== 200 || promptsRes.status !== 200) return;
  const tasks = (tasksRes.data as { tasks: { title: string; runner?: string }[] }).tasks;
  const prompts = (promptsRes.data as { prompts: TestPrompt[] }).prompts;
  const agentTasks = tasks.filter((t) => (t.runner ?? 'agent') === 'agent');
  if (prompts.length !== agentTasks.length) {
    throw new Error(
      `test-prompts count ${prompts.length} != agent-runner catalog count ${agentTasks.length}`
    );
  }
  for (let i = 0; i < agentTasks.length; i++) {
    if (prompts[i].title !== agentTasks[i].title) {
      throw new Error(
        `test-prompts[${i}].title "${prompts[i].title}" != catalog title "${agentTasks[i].title}"`
      );
    }
  }
}

async function testPrompts_tagsMatchCatalog() {
  // Tags drive the picker's tag filter — they must pass through from the
  // catalog verbatim, entry by entry.
  const tasksRes = await request(`${BASE_URL}/api/benchmarks`);
  const promptsRes = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (tasksRes.status !== 200 || promptsRes.status !== 200) return;
  const tasks = (tasksRes.data as { tasks: { title: string; runner?: string; tags?: string[] }[] })
    .tasks;
  const prompts = (promptsRes.data as { prompts: TestPrompt[] }).prompts;
  const agentTasks = tasks.filter((t) => (t.runner ?? 'agent') === 'agent');
  if (prompts.length !== agentTasks.length) return; // drift guard covers count mismatch
  for (let i = 0; i < agentTasks.length; i++) {
    const expected = agentTasks[i].tags ?? [];
    if (JSON.stringify(prompts[i].tags) !== JSON.stringify(expected)) {
      throw new Error(
        `test-prompts[${i}] "${prompts[i].title}" tags ${JSON.stringify(prompts[i].tags)} != catalog tags ${JSON.stringify(expected)}`
      );
    }
  }
  if (!prompts.some((p) => p.tags.length > 0)) {
    throw new Error('No prompt carries any tags — tag pass-through appears broken');
  }
}

async function testPrompts_excludeExternalRunners() {
  const res = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res.status !== 200) return;
  const body = res.data as { prompts: TestPrompt[] };
  const external = body.prompts.filter((p) => p.title.startsWith('Backend Smoke:'));
  if (external.length > 0) {
    throw new Error(`External vitest smokes leaked into test-prompts: ${external.length}`);
  }
}

async function testPrompts_attachmentUrlsUseTestAssets() {
  const res = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res.status !== 200) return;
  const body = res.data as { prompts: TestPrompt[] };
  for (const prompt of body.prompts) {
    for (const url of prompt.attachmentUrls) {
      if (!url.startsWith('/test-assets/')) {
        throw new Error(`Prompt "${prompt.title}" attachment not under /test-assets/: ${url}`);
      }
    }
  }
}

async function testPrompts_frontendUrlTokenRewritten() {
  const res = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res.status !== 200) return;
  const body = res.data as { prompts: TestPrompt[] };
  const leaking = body.prompts.filter((p) => p.prompt.includes('{frontend_url}'));
  if (leaking.length > 0) {
    throw new Error(
      `Prompts still contain run_benchmark's {frontend_url} token: ${leaking
        .map((p) => p.title)
        .join(', ')}`
    );
  }
}

async function testPrompts_devDefaultPresent() {
  // The FE auto-loads this title on mount in dev mode — it must exist in the catalog.
  const res = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res.status !== 200) return;
  const body = res.data as { prompts: TestPrompt[] };
  if (!body.prompts.some((p) => p.title === 'Family Office & Angel Outreach')) {
    throw new Error('Dev default prompt "Family Office & Angel Outreach" missing from catalog');
  }
}

async function testPrompts_idempotentSameResponse() {
  const res1 = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  const res2 = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res1.status !== res2.status) {
    throw new Error(`Status mismatch: first=${res1.status}, second=${res2.status}`);
  }
  if (res1.status === 200 && JSON.stringify(res1.data) !== JSON.stringify(res2.data)) {
    throw new Error('Idempotency violation: two identical GETs returned different data');
  }
}

// ==================== RUNNER ====================

async function runAll() {
  console.log('Benchmarks Test-Prompts Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}\n`);

  const tests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'happy path (200 or 500)', fn: testPrompts_happy },
    { name: 'matches agent-runner catalog entries', fn: testPrompts_matchAgentCatalogEntries },
    { name: 'tags match catalog entries', fn: testPrompts_tagsMatchCatalog },
    { name: 'excludes external vitest smokes', fn: testPrompts_excludeExternalRunners },
    { name: 'attachment urls under /test-assets/', fn: testPrompts_attachmentUrlsUseTestAssets },
    { name: '{frontend_url} token rewritten', fn: testPrompts_frontendUrlTokenRewritten },
    { name: 'dev default prompt present', fn: testPrompts_devDefaultPresent },
    { name: 'idempotent same response', fn: testPrompts_idempotentSameResponse },
  ];

  const results = await Promise.all(tests.map((t) => runTest(t.name, t.fn)));
  for (const result of results) {
    const icon = result.passed ? '  PASS' : '  FAIL';
    console.log(
      `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
    );
  }

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\nResults: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`
  );
  if (failed.length > 0) {
    process.exit(1);
  }
  console.log('\nALL BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
