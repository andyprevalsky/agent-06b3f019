#!/usr/bin/env tsx

/**
 * Black-box tests for /api/benchmarks
 *
 * Domain surface:
 *   GET /api/benchmarks — public, no auth, returns task definitions from agents/benchmarks/tasks.json
 *
 * Boundary capture coverage:
 *   This domain makes zero outbound third-party HTTP calls. The endpoint reads tasks.json
 *   from disk on each request. A boundary capture test verifies that no outbound calls are
 *   triggered by a GET request.
 *
 * Invariants covered:
 *   - auth boundary: endpoint is public, works without any auth headers
 *   - error-surface: only valid responses are 200 with tasks or 500 with { error: string }
 *   - idempotency: multiple GETs return identical data (read from tasks.json)
 *   - ordering: task order is deterministic across requests
 *   - concurrency: 10 parallel GETs return consistent results
 *   - duplication prevention: task names are unique
 *   - same-input reproducibility: three sequential requests return identical responses
 *   - boundary param: no outbound calls are made (verified via fetch capture)
 *   - cleanup: tests create no mutable state; nothing to clean up
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Invariants not applicable:
 *   - read-after-write consistency: read-only endpoint, no writes
 *   - state transition: stateless endpoint
 *   - atomicity: read-only, no transactions
 *   - referential integrity: no foreign keys or DB relations
 *   - event/job cardinality: no events emitted
 *   - tenant isolation: public endpoint, no user scoping
 *   - time/clock: no timestamps in response
 *   - call ordering: no outbound calls to order
 *
 * Usage:
 *   npx tsx src/tests/blackbox/benchmarks.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/benchmarks.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';
import { KNOWN_TAGS } from './benchmarks-known-tags';
import { KNOWN_TASK_NAMES } from './benchmarks-known-task-names';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);

// ==================== RESPONSE SCHEMAS ====================

const BenchmarkTaskSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  timeout_seconds: z.number().int().min(0),
  is_chat_mode: z.boolean(),
  expected_tools: z.array(z.string()),
  tags: z.array(z.string().min(1)),
  price_limit_cents: z.number().int().positive(),
  requires_browser_agent: z.boolean(),
  requires_claude_code: z.boolean(),
  // One file name, or a list (raise-5m attaches its whole pre-seed materials set).
  attachment: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).nullable(),
  approval_handling: z.string().nullable(),
  start_phase: z.string().nullable(),
  // Unified eval-catalog contract (additive, optional — validated by agents/benchmarks/long_horizon.py)
  status: z.enum(['ready', 'incomplete']).optional(),
  runner: z.enum(['agent', 'vitest', 'sms']).optional(),
  description: z.string().min(1).optional(),
  environment: z
    .object({
      mode: z.enum(['synthetic', 'live', 'hybrid']),
      db_fixtures: z.array(z.string()),
      base_images: z.array(z.string()),
      services: z.array(z.string()),
      secrets: z.array(z.string()),
      live_targets: z.array(z.string()),
      context_notes: z.string().min(1),
    })
    .optional(),
  evaluators: z
    .array(
      z.object({
        id: z.string().min(1),
        method: z.enum([
          'static_check',
          'single_turn_llm_judge',
          'agentic_llm_judge',
          'polar',
          'code_bench_screenshot_judge',
        ]),
        criteria: z.array(z.string().min(1)).min(1),
        checks: z.array(z.object({ type: z.string().min(1) }).passthrough()).optional(),
        judge_prompt: z.string().min(1).optional(),
        rubrics: z
          .array(
            z.object({
              id: z.string().min(1),
              requirement: z.string().min(1),
              verification: z.string().min(1),
            })
          )
          .optional(),
        pass_threshold: z.number().min(0).max(1).optional(),
      })
    )
    .optional(),
  source: z.array(z.string().min(1)).optional(),
  max_steps: z.record(z.string(), z.number().int().positive()).optional(),
});

const TasksResponseSchema = z.object({
  tasks: z.array(BenchmarkTaskSchema),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
});

type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;

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

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected)
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(`${label} schema validation failed: ${result.error.message}`);
  return result.data;
}

// ==================== GET /api/benchmarks — CONTRACT TESTS ====================

async function testList_happy() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status === 200) {
    assertSchema(TasksResponseSchema, res.data, 'GET /api/benchmarks');
  } else if (res.status === 500) {
    // tasks.json may not exist in dev — acceptable degraded response
    assertSchema(ErrorResponseSchema, res.data, 'GET /api/benchmarks (error)');
  } else {
    throw new Error(
      `Unexpected status ${res.status}: ${JSON.stringify(res.data).substring(0, 300)}`
    );
  }
}

async function testList_returnsNonEmptyTasks() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return; // skip if tasks unavailable in dev
  const body = assertSchema(TasksResponseSchema, res.data, 'GET /api/benchmarks');
  if (body.tasks.length === 0) throw new Error('Expected at least 1 task, got 0');
}

async function testList_taskCountMatchesKnown() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  if (body.tasks.length < KNOWN_TASK_NAMES.length) {
    throw new Error(`Expected at least ${KNOWN_TASK_NAMES.length} tasks, got ${body.tasks.length}`);
  }
}

async function testList_allKnownTasksPresent() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  const returnedNames = new Set(body.tasks.map((t) => t.name));
  const missing = KNOWN_TASK_NAMES.filter((n) => !returnedNames.has(n));
  if (missing.length > 0) throw new Error(`Missing known tasks: ${missing.join(', ')}`);
}

async function testList_taskNamesUnique() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  const seen = new Set<string>();
  for (const task of body.tasks) {
    if (seen.has(task.name)) throw new Error(`Duplicate task name: ${task.name}`);
    seen.add(task.name);
  }
}

async function testList_taskItemShape() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: unknown[] };
  // Validate each task individually for better error messages
  for (let i = 0; i < body.tasks.length; i++) {
    const result = BenchmarkTaskSchema.safeParse(body.tasks[i]);
    if (!result.success) {
      const name = (body.tasks[i] as { name?: string })?.name ?? `index ${i}`;
      throw new Error(`Task "${name}" schema validation failed: ${result.error.message}`);
    }
  }
}

async function testList_tagsAreKnown() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  const knownSet = new Set(KNOWN_TAGS);
  // Report EVERY unknown tag in one pass. Throwing on the first one makes a
  // task that adds N new tags cost N full coverage reruns to discover.
  const unknown = new Map<string, string[]>();
  for (const task of body.tasks) {
    for (const tag of task.tags) {
      if (!knownSet.has(tag)) {
        const owners = unknown.get(tag) ?? [];
        if (!owners.includes(task.name)) owners.push(task.name);
        unknown.set(tag, owners);
      }
    }
  }
  if (unknown.size > 0) {
    const detail = [...unknown.entries()]
      .map(([tag, tasks]) => `"${tag}" (${tasks.join(', ')})`)
      .join('; ');
    throw new Error(
      `${unknown.size} unknown tag(s): ${detail}. ` +
        `Add them to benchmarks-known-tags.ts. Known: ${KNOWN_TAGS.join(', ')}`
    );
  }
}

async function testList_everyTaskHasAtLeastOneTag() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  for (const task of body.tasks) {
    if (task.tags.length === 0) throw new Error(`Task "${task.name}" has no tags`);
  }
}

async function testList_contentTypeHeader() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  const ct = res.headers.get('content-type');
  if (!ct || !ct.includes('application/json')) {
    throw new Error(`Expected Content-Type application/json, got: ${ct}`);
  }
}

// ==================== AUTH BOUNDARY INVARIANT ====================

async function testList_noAuthRequired() {
  // Request with zero auth headers — should still succeed
  const response = await fetch(`${BASE_URL}/api/benchmarks`);
  if (response.status !== 200 && response.status !== 500) {
    throw new Error(`Expected 200 or 500 without auth, got ${response.status}`);
  }
}

async function testPreview_disabledOutsideBenchmark() {
  const response = await fetch(`${BASE_URL}/api/benchmarks/agent-preview/not-real`);
  if (response.status !== 404) {
    throw new Error(
      `Expected benchmark preview to be hidden outside benchmark mode, got ${response.status}`
    );
  }
}

async function testClaudeSessionPreview_disabledOutsideBenchmark() {
  const response = await fetch(`${BASE_URL}/api/benchmarks/claude-code-session-preview/not-real`);
  if (response.status !== 404) {
    throw new Error(
      `Expected Claude session preview to be hidden outside benchmark mode, got ${response.status}`
    );
  }
}

// ==================== ERROR SURFACE INVARIANT ====================

async function testList_postMethodNotAllowed() {
  const res = await request(`${BASE_URL}/api/benchmarks`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  // Express returns 404 for unmatched method on this route (no POST handler)
  if (res.status === 200) throw new Error('POST should not return 200');
}

async function testList_putMethodNotAllowed() {
  const res = await request(`${BASE_URL}/api/benchmarks`, {
    method: 'PUT',
    body: JSON.stringify({}),
  });
  if (res.status === 200) throw new Error('PUT should not return 200');
}

async function testList_deleteMethodNotAllowed() {
  const res = await request(`${BASE_URL}/api/benchmarks`, { method: 'DELETE' });
  if (res.status === 200) throw new Error('DELETE should not return 200');
}

async function testList_patchMethodNotAllowed() {
  const res = await request(`${BASE_URL}/api/benchmarks`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  if (res.status === 200) throw new Error('PATCH should not return 200');
}

// ==================== IDEMPOTENCY / CACHE INVARIANT ====================

async function testList_idempotentSameResponse() {
  const res1 = await request(`${BASE_URL}/api/benchmarks`);
  const res2 = await request(`${BASE_URL}/api/benchmarks`);
  if (res1.status !== res2.status) {
    throw new Error(`Status mismatch: first=${res1.status}, second=${res2.status}`);
  }
  if (res1.status === 200) {
    const a = JSON.stringify(res1.data);
    const b = JSON.stringify(res2.data);
    if (a !== b)
      throw new Error('Idempotency violation: two identical GETs returned different data');
  }
}

// ==================== ORDERING INVARIANT ====================

async function testList_taskOrderDeterministic() {
  const res1 = await request(`${BASE_URL}/api/benchmarks`);
  const res2 = await request(`${BASE_URL}/api/benchmarks`);
  if (res1.status !== 200 || res2.status !== 200) return;
  const names1 = (res1.data as { tasks: BenchmarkTask[] }).tasks.map((t) => t.name);
  const names2 = (res2.data as { tasks: BenchmarkTask[] }).tasks.map((t) => t.name);
  if (JSON.stringify(names1) !== JSON.stringify(names2)) {
    throw new Error('Task ordering is not deterministic between consecutive GETs');
  }
}

// ==================== CONCURRENCY INVARIANT ====================

async function testList_concurrentRequestsConsistent() {
  const requests = Array.from({ length: 10 }, () => request(`${BASE_URL}/api/benchmarks`));
  const results = await Promise.all(requests);

  const statuses = new Set(results.map((r) => r.status));
  if (statuses.size > 1) {
    throw new Error(`Concurrent requests returned mixed statuses: ${[...statuses].join(', ')}`);
  }

  if (results[0].status === 200) {
    const baseline = JSON.stringify(results[0].data);
    for (let i = 1; i < results.length; i++) {
      if (JSON.stringify(results[i].data) !== baseline) {
        throw new Error(`Concurrent request ${i} returned different data than request 0`);
      }
    }
  }
}

// ==================== SAME-INPUT REPRODUCIBILITY INVARIANT ====================

async function testList_reproducibleAcrossThreeRuns() {
  const snapshots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/benchmarks`);
    snapshots.push(JSON.stringify({ status: res.status, data: res.data }));
  }
  if (new Set(snapshots).size !== 1) {
    throw new Error('Three sequential GETs did not return identical responses');
  }
}

// ==================== TASK DATA INVARIANTS ====================

async function testList_timeoutsAreValid() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  for (const task of body.tasks) {
    if (task.timeout_seconds < 0) {
      throw new Error(`Task "${task.name}" has negative timeout: ${task.timeout_seconds}`);
    }
    if (task.timeout_seconds === 0) {
      const tags = task.tags ?? [];
      if (!tags.includes('polar-bench')) {
        throw new Error(
          `Task "${task.name}" disables wall-clock timeout (0) without polar-bench tag`
        );
      }
      const maxSteps = (task as BenchmarkTask & { max_steps?: Record<string, number> }).max_steps;
      if (!maxSteps?.browser || maxSteps.browser <= 0) {
        throw new Error(
          `Task "${task.name}" disables wall-clock timeout but lacks max_steps.browser`
        );
      }
    }
  }
}

async function testList_priceLimitsArePositive() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  for (const task of body.tasks) {
    if (task.price_limit_cents <= 0)
      throw new Error(
        `Task "${task.name}" has non-positive price limit: ${task.price_limit_cents}`
      );
  }
}

async function testList_chatModeTasksHaveNoStartPhase() {
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  for (const task of body.tasks) {
    if (task.is_chat_mode && task.start_phase !== null) {
      throw new Error(
        `Chat-mode task "${task.name}" should have null start_phase, got "${task.start_phase}"`
      );
    }
  }
}

async function testList_approvalHandlingValues() {
  const validValues = new Set([null, 'auto_approve', 'prompt_user', 'ignore', 'count_only']);
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  for (const task of body.tasks) {
    if (!validValues.has(task.approval_handling)) {
      throw new Error(
        `Task "${task.name}" has invalid approval_handling: "${task.approval_handling}"`
      );
    }
  }
}

async function testList_startPhaseValues() {
  const validValues = new Set([null, 'plan', 'execute']);
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status !== 200) return;
  const body = res.data as { tasks: BenchmarkTask[] };
  for (const task of body.tasks) {
    if (!validValues.has(task.start_phase)) {
      throw new Error(`Task "${task.name}" has invalid start_phase: "${task.start_phase}"`);
    }
  }
}

// ==================== CAPTURE TYPES ====================

interface CapturedCall {
  id: number;
  timestamp: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
}

/** Infrastructure URLs from concurrent tests (not from the endpoint under test). */
const INFRA_URL_PATTERNS = [
  'anthropic.com',
  'openai.com',
  'chatgpt.com',
  'openrouter.ai',
  'supabase.co',
  'api.github.com',
  'ip-api.com',
  'surge.app',
  'verify.twilio.com',
  'e2b.app',
  'stripe.com',
  'parallel.ai',
  'exa.ai',
  'perplexity.ai',
  'vapi.ai',
  'googleapis.com',
  'connect.steelbrowser.com',
  'connect.steel.dev',
  'api.steel.dev',
];
function filterInfraCalls<T extends { url: string }>(calls: T[]): T[] {
  return calls.filter((c) => !INFRA_URL_PATTERNS.some((p) => c.url.includes(p)));
}

// ==================== CAPTURE HELPERS ====================

async function readCapturesForToken(token: string): Promise<CapturedCall[]> {
  const res = await request(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  assertStatus(res.status, 200, res.data);
  return (res.data as { captures: CapturedCall[] }).captures;
}

// ==================== BOUNDARY CAPTURE — NO OUTBOUND CALLS ====================

async function testBoundary_noOutboundCalls() {
  // Probe capture endpoint — if not active, skip gracefully.
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) return;

  const captureToken = `benchmarks-${crypto.randomUUID()}`;
  await request(`${BASE_URL}/api/benchmarks`, {
    headers: { 'X-Capture-Token': captureToken },
  });
  const calls = await readCapturesForToken(captureToken);
  const real = filterInfraCalls(calls);
  if (real.length > 0) {
    throw new Error(
      `Expected 0 outbound calls, got ${real.length}: ${JSON.stringify(real.map((c) => c.url))}`
    );
  }
}

// ==================== 500 ERROR SHAPE INVARIANT ====================

async function testError_schemaOnFailure() {
  // We can't force a 500 from the outside (tasks.json must be present on disk),
  // but we verify that IF the endpoint returns 500, the body matches ErrorResponseSchema.
  const res = await request(`${BASE_URL}/api/benchmarks`);
  if (res.status === 500) {
    assertSchema(ErrorResponseSchema, res.data, 'GET /api/benchmarks (500)');
  }
  // If 200, this test is a no-op — the error path can only be triggered by startup failure.
}

// ==================== RUNNER ====================

interface TestGroup {
  name: string;
  tests: { name: string; fn: () => Promise<void> }[];
}

async function runAll() {
  console.log('Benchmarks Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}; case concurrency: ${CASE_CONCURRENCY}\n`);

  // Parallel groups — safe for concurrent execution
  const parallelGroups: TestGroup[] = [
    {
      name: 'GET /api/benchmarks — contract',
      tests: [
        { name: 'happy path (200 or 500)', fn: testList_happy },
        { name: 'returns non-empty tasks', fn: testList_returnsNonEmptyTasks },
        { name: 'task count >= known count', fn: testList_taskCountMatchesKnown },
        { name: 'all known tasks present', fn: testList_allKnownTasksPresent },
        { name: 'task names unique', fn: testList_taskNamesUnique },
        { name: 'task item schema', fn: testList_taskItemShape },
        { name: 'tags are known values', fn: testList_tagsAreKnown },
        { name: 'every task has >= 1 tag', fn: testList_everyTaskHasAtLeastOneTag },
        { name: 'Content-Type: application/json', fn: testList_contentTypeHeader },
      ],
    },
    {
      name: 'Auth boundary',
      tests: [
        { name: 'no auth required', fn: testList_noAuthRequired },
        {
          name: 'agent preview hidden outside benchmark mode',
          fn: testPreview_disabledOutsideBenchmark,
        },
        {
          name: 'claude session preview hidden outside benchmark mode',
          fn: testClaudeSessionPreview_disabledOutsideBenchmark,
        },
      ],
    },
    {
      name: 'Error surface',
      tests: [
        { name: 'POST not allowed', fn: testList_postMethodNotAllowed },
        { name: 'PUT not allowed', fn: testList_putMethodNotAllowed },
        { name: 'DELETE not allowed', fn: testList_deleteMethodNotAllowed },
        { name: 'PATCH not allowed', fn: testList_patchMethodNotAllowed },
        { name: '500 error shape (if applicable)', fn: testError_schemaOnFailure },
      ],
    },
    {
      name: 'Idempotency',
      tests: [
        { name: 'idempotent same response', fn: testList_idempotentSameResponse },
        { name: 'task order deterministic', fn: testList_taskOrderDeterministic },
      ],
    },
    {
      name: 'Concurrency',
      tests: [{ name: '10 concurrent GETs consistent', fn: testList_concurrentRequestsConsistent }],
    },
    {
      name: 'Reproducibility',
      tests: [
        { name: 'three sequential runs identical', fn: testList_reproducibleAcrossThreeRuns },
      ],
    },
    {
      name: 'Task data invariants',
      tests: [
        { name: 'timeouts valid', fn: testList_timeoutsAreValid },
        { name: 'price limits positive', fn: testList_priceLimitsArePositive },
        {
          name: 'chat-mode tasks have null start_phase',
          fn: testList_chatModeTasksHaveNoStartPhase,
        },
        { name: 'approval_handling values valid', fn: testList_approvalHandlingValues },
        { name: 'start_phase values valid', fn: testList_startPhaseValues },
      ],
    },
  ];

  // Sequential groups — boundary capture tests use shared global state
  const sequentialGroups: TestGroup[] = [
    {
      name: 'Boundary capture',
      tests: [{ name: 'zero outbound calls on GET', fn: testBoundary_noOutboundCalls }],
    },
  ];

  const allGroups = [...parallelGroups, ...sequentialGroups];

  // Flatten parallel tests for concurrent execution
  const parallelTests: { groupName: string; name: string; fn: () => Promise<void> }[] = [];
  for (const group of parallelGroups) {
    for (const test of group.tests) {
      parallelTests.push({ groupName: group.name, name: test.name, fn: test.fn });
    }
  }

  // Run parallel tests concurrently with case concurrency limit
  const allResults: (TestResult & { groupName: string })[] = [];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= parallelTests.length) return;
      const t = parallelTests[idx];
      const result = await runTest(`${t.groupName} -- ${t.name}`, t.fn);
      allResults[idx] = { ...result, groupName: t.groupName };
    }
  }

  const workerCount = Math.min(CASE_CONCURRENCY, parallelTests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Run sequential boundary tests one at a time
  for (const group of sequentialGroups) {
    for (const test of group.tests) {
      const result = await runTest(`${group.name} -- ${test.name}`, test.fn);
      allResults.push({ ...result, groupName: group.name });
    }
  }

  // Print results grouped
  for (const group of allGroups) {
    console.log(`\n  ${group.name}`);
    for (const test of group.tests) {
      const result = allResults.find(
        (r) => r.groupName === group.name && r.name.endsWith(test.name)
      )!;
      const icon = result.passed ? '  PASS' : '  FAIL';
      console.log(
        `${icon}  ${test.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
      );
    }
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(
    `\nResults: ${passed} passed, ${failed} failed, ${allResults.length} total (caseConcurrency=${workerCount})`
  );
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('\nALL BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
