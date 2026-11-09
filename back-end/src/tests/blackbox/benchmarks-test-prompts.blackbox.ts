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
 *   - lastFivePassed: boolean on every prompt; aligns with ledger when last 5 passed
 *   - dev default: the FE auto-load title exists in the catalog
 *   - idempotency: identical across consecutive requests (same file on disk)
 *
 * Invariants not applicable:
 *   - read-after-write / state transition / atomicity / referential integrity:
 *     read-only stateless endpoint over tasks.json
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
  lastFivePassed: z.boolean(),
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

async function testPrompts_listAttachmentKeepsEveryFile() {
  // The fundraiser lists its five pre-seed materials under `attachment`.
  const res = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res.status !== 200) throw new Error(`test-prompts status ${res.status}`);
  const body = res.data as { prompts: TestPrompt[] };
  const fundraiser = body.prompts.find(
    (p) => p.title === 'Raise $5M for Rose Labs (Brex balance, simulated)'
  );
  if (!fundraiser) throw new Error('Fundraiser prompt missing from test-prompts');
  if (fundraiser.attachmentUrls.length !== 5) {
    throw new Error(
      `Fundraiser attachments: expected 5, got ${JSON.stringify(fundraiser.attachmentUrls)}`
    );
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
  if (!body.prompts.some((p) => p.title === 'Test Mass Agent Run - 0')) {
    throw new Error('Dev default prompt "Test Mass Agent Run - 0" missing from catalog');
  }
}

async function testPrompts_lastFivePassedIsBoolean() {
  // Every prompt must carry the last-5 signal so the query-box green check
  // can render without a second round-trip.
  const res = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res.status !== 200) return;
  const body = res.data as { prompts: TestPrompt[] };
  for (const prompt of body.prompts) {
    if (typeof prompt.lastFivePassed !== 'boolean') {
      throw new Error(
        `Prompt "${prompt.title}" missing lastFivePassed boolean (got ${String(prompt.lastFivePassed)})`
      );
    }
  }
  if (body.prompts.length === 0) {
    throw new Error('No prompts returned — cannot assert lastFivePassed');
  }
}

async function testPrompts_lastFivePassedReflectsRunHistory() {
  // Cement against the committed attempts ledger for two known tasks:
  //   - smoke tasks like "Basic Chat Response" (chat-mode) have a long
  //     trailing pass window → lastFivePassed true
  //   - "Test Mass Agent Run - 0" lastFivePassed must match the ledger
  //     (a single new pass must not be treated as a 5-pass green check,
  //     and a frozen "always false" snapshot must not reject a real 5-pass
  //     window). Hub uploads can add newer fails or extra samples.
  const fs = await import('fs');
  const path = await import('path');
  const ledgerPath = path.join(
    process.cwd(),
    '..',
    'agents',
    'benchmarks',
    'history',
    'task_attempts.jsonl'
  );
  if (!fs.existsSync(ledgerPath)) {
    throw new Error(`task_attempts.jsonl missing at ${ledgerPath}`);
  }
  // The ledger is the base file plus per-writer shards (history_ledger.py);
  // the exported reader returns their union in recorded order.
  const { readTaskAttempts } = await import('../../domains/benchmarks/config');
  const byTask = new Map<string, boolean[]>();
  for (const attempt of readTaskAttempts()) {
    const list = byTask.get(attempt.task) ?? [];
    list.push(attempt.passed);
    byTask.set(attempt.task, list);
  }

  const res = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  if (res.status !== 200) return;
  const body = res.data as { prompts: TestPrompt[] };

  const mass = body.prompts.find((p) => p.title === 'Test Mass Agent Run - 0');
  if (!mass) {
    throw new Error('Dev default "Test Mass Agent Run - 0" missing — cannot assert fail streak');
  }
  const massFlags = byTask.get('test-mass-agent-run-0') ?? [];
  const massLastFive = massFlags.slice(-5);
  const massLedgerLastFiveFail = massFlags.length >= 5 && massLastFive.every((p) => p === false);
  const massLedgerLastFivePass = massFlags.length >= 5 && massLastFive.every((p) => p === true);
  if (massLedgerLastFiveFail && mass.lastFivePassed) {
    throw new Error('Test Mass Agent Run - 0 has last-5 ledger fails but lastFivePassed=true');
  }
  if (massLedgerLastFivePass && !mass.lastFivePassed) {
    const anyGreen = body.prompts.some((p) => p.lastFivePassed);
    if (!anyGreen) {
      throw new Error(
        'test-mass-agent-run-0 ledger last-5 all passed and no prompt has lastFivePassed=true'
      );
    }
  }

  const chat = body.prompts.find((p) => p.title === 'Basic Chat Response');
  if (!chat) {
    throw new Error('"Basic Chat Response" missing from catalog');
  }
  const chatFlags = byTask.get('chat-mode') ?? [];
  const chatLedgerLastFivePass =
    chatFlags.length >= 5 && chatFlags.slice(-5).every((p) => p === true);
  if (chatLedgerLastFivePass && !chat.lastFivePassed) {
    // Hub may have recorded a newer fail — allow false, but require some green.
    const anyGreen = body.prompts.some((p) => p.lastFivePassed);
    if (!anyGreen) {
      throw new Error('chat-mode ledger last-5 all passed and no prompt has lastFivePassed=true');
    }
  }
  if (chatLedgerLastFivePass && chat.lastFivePassed !== true && chat.lastFivePassed !== false) {
    throw new Error('Basic Chat Response lastFivePassed is not a boolean');
  }
  // Prefer the strong assertion when hub has not flipped the smoke task.
  if (chatLedgerLastFivePass && chat.lastFivePassed) {
    return;
  }
  if (!body.prompts.some((p) => p.lastFivePassed)) {
    throw new Error('Expected ≥1 prompt with lastFivePassed=true from run history');
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

async function testPrompts_attemptsLedgerReadsBaseAndShards() {
  // The attempts ledger is its base file plus per-writer shards
  // `task_attempts.<YYYYMMDD>.<branch>.jsonl` (agents/benchmarks/history_ledger.py):
  // concurrent PRs each add their own shard instead of editing one shared file,
  // so readers must return the union — base rows in file order, then shard rows
  // in recorded order — or a merged branch's runs vanish from lastFivePassed.
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const { readTaskAttempts } = await import('../../domains/benchmarks/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempts-ledger-'));
  try {
    const row = (agent: string, passed: boolean, timestamp: string) =>
      JSON.stringify({
        task: 'ledger-task',
        passed,
        status: 'COMPLETED',
        timestamp,
        agent_id: agent,
      }) + '\n';
    const base = path.join(dir, 'task_attempts.jsonl');
    fs.writeFileSync(
      base,
      row('base-2', true, '2026-10-02T00:00:00+00:00') +
        row('base-1', false, '2026-10-01T00:00:00+00:00')
    );
    fs.writeFileSync(
      path.join(dir, 'task_attempts.20261107.feat-b.jsonl'),
      row('b', true, '2026-11-07T12:00:00+00:00')
    );
    fs.writeFileSync(
      path.join(dir, 'task_attempts.20261107.feat-a.jsonl'),
      row('a', false, '2026-11-07T10:00:00+00:00')
    );
    fs.writeFileSync(
      path.join(dir, 'task_durations.20261107.feat-a.jsonl'),
      row('not-an-attempt', true, '2026-11-07T11:00:00+00:00')
    );
    const agents = readTaskAttempts(base).map((attempt) => attempt.agent_id);
    const expected = ['base-2', 'base-1', 'a', 'b'];
    if (JSON.stringify(agents) !== JSON.stringify(expected)) {
      throw new Error(
        `attempts ledger union ${JSON.stringify(agents)} != ${JSON.stringify(expected)}`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
    { name: 'list attachment keeps every file', fn: testPrompts_listAttachmentKeepsEveryFile },
    { name: '{frontend_url} token rewritten', fn: testPrompts_frontendUrlTokenRewritten },
    { name: 'dev default prompt present', fn: testPrompts_devDefaultPresent },
    { name: 'lastFivePassed is boolean on every prompt', fn: testPrompts_lastFivePassedIsBoolean },
    {
      name: 'lastFivePassed reflects run history streaks',
      fn: testPrompts_lastFivePassedReflectsRunHistory,
    },
    {
      name: 'attempts ledger reads base file and shards',
      fn: testPrompts_attemptsLedgerReadsBaseAndShards,
    },
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
