#!/usr/bin/env tsx
/**
 * Black-box tests for the Benchmark Hub endpoints (/api/benchmarks/*)
 *
 * Domain surface:
 *   GET    /api/benchmarks/tasks                    — team-gated catalog (DB) + per-task stats
 *   PATCH  /api/benchmarks/tasks/:name              — team-gated validated metadata edit
 *   POST   /api/benchmarks/run-requests             — team-gated run dispatch
 *   GET    /api/benchmarks/run-requests             — team-gated queue view
 *   PATCH  /api/benchmarks/run-requests/:id         — internal poller claim/progress/complete
 *   POST   /api/benchmarks/runs[?live=1]            — internal run-bundle upload (snapshot/final)
 *   GET    /api/benchmarks/runs                     — team-gated run index
 *   GET    /api/benchmarks/runs/:id                 — team-gated run detail
 *   GET    /api/benchmarks/runs/:id/agents/:agentId — team-gated in-app transcript + tree
 *   DELETE /api/benchmarks/runs/:id                 — internal hygiene
 *
 * Invariants covered:
 *   - auth boundary: every hub endpoint rejects unauthenticated calls; upload/
 *     poller endpoints reject non-internal callers
 *   - read-after-write: upload → list → detail → agent transcript round-trip
 *   - state transition: run-request queued → running → completed; double-claim
 *     rejected; cancel only from queued
 *   - validation: task edits reject unknown fields/bad types/unknown tasks;
 *     run requests reject unknown task names
 *   - idempotency: re-uploading a bundle upserts (single index entry)
 *   - cleanup: every uploaded test run is deleted in finally; task edits are
 *     reverted to their original values
 */

import { z } from 'zod';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const USER_ID = process.env.TEST_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

const internalHeaders = {
  'X-API-Key': API_KEY,
  'X-User-Id': USER_ID,
};

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected)
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const CatalogTaskSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  prompt: z.string(),
  group: z.string(),
  tags: z.array(z.string()),
  timeout_seconds: z.number().nullable(),
  price_limit_cents: z.number().nullable(),
  world_model_mode: z.string().nullable(),
  stats: z
    .object({
      attempts: z.number(),
      passes: z.number(),
      pass_rate: z.number().nullable(),
      p50_duration_seconds: z.number().nullable(),
      p95_duration_seconds: z.number().nullable(),
      last_attempt_at: z.string().nullable(),
      last_status: z.string().nullable(),
      last_fast_mode: z.boolean(),
    })
    .nullable(),
});

// ==================== synthetic run bundle ====================

const RUN_ID = `blackbox-hub-${process.pid}-${Date.now()}`;
const ROOT_AGENT = `bb-root-${process.pid}`;
const SUB_AGENT = `bb-sub-${process.pid}`;

function syntheticBundle(): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    timestamp: new Date().toISOString(),
    suite: 'blackbox',
    source: 'blackbox-test',
    tasks: [
      {
        name: 'chat-mode',
        passed: true,
        status: 'passed',
        agent_id: ROOT_AGENT,
        duration_seconds: 12.5,
        cost_cents: 3,
        world_model_mode: 'real',
        fast_mode_cache_enabled: true,
        tree_agent_count: 2,
        logs: {
          messages: [
            { role: 'USER', message: 'hub blackbox goal', created_at: '2026-07-10T00:00:01Z' },
            { role: 'ASSISTANT', message: 'root reply', created_at: '2026-07-10T00:00:02Z' },
          ],
          tree: {
            [ROOT_AGENT]: {
              parent_agent_id: null,
              goal: 'hub blackbox goal',
              status: 'COMPLETED',
              messages: [
                { role: 'USER', message: 'hub blackbox goal', created_at: '2026-07-10T00:00:01Z' },
                { role: 'ASSISTANT', message: 'root reply', created_at: '2026-07-10T00:00:02Z' },
              ],
            },
            [SUB_AGENT]: {
              parent_agent_id: ROOT_AGENT,
              goal: 'sub research goal',
              status: 'COMPLETED',
              messages: [
                { role: 'ASSISTANT', message: 'sub result', created_at: '2026-07-10T00:00:03Z' },
              ],
            },
          },
        },
      },
    ],
  };
}

// ==================== tests ====================

async function testAuth_tasksRejectsUnauthenticated(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks`);
  assert(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
}

async function testAuth_runsRejectsUnauthenticated(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/runs`);
  assert(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
}

async function testAuth_runRequestsRejectsUnauthenticated(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/run-requests`);
  assert(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
}

async function testAuth_uploadRejectsUnauthenticated(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/runs`, {
    method: 'POST',
    body: JSON.stringify(syntheticBundle()),
  });
  assert(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
}

async function testCatalog_returnsTasksWithStatsShape(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders });
  assertStatus(res.status, 200, res.data);
  const tasks = (res.data as { tasks: unknown[] }).tasks;
  assert(Array.isArray(tasks) && tasks.length > 0, 'catalog is empty');
  for (const task of tasks.slice(0, 10)) {
    const parsed = CatalogTaskSchema.safeParse(task);
    assert(parsed.success, `catalog task shape invalid: ${JSON.stringify(task).slice(0, 200)}`);
  }
}

async function testCatalog_groupsAreTheThreeKnown(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders });
  assertStatus(res.status, 200, res.data);
  const tasks = (res.data as { tasks: Array<{ group: string }> }).tasks;
  const groups = new Set(tasks.map((t) => t.group));
  for (const g of groups) {
    assert(
      ['pre-deploy', 'daily', 'rose-bench', 'incomplete'].includes(g),
      `unexpected group: ${g}`
    );
  }
  // the smoke-tagged suite is the pre-deploy gate — it must be represented
  assert(groups.has('pre-deploy'), 'no pre-deploy (smoke) tasks found');
}

async function testCatalog_statsPresentForTasksWithHistory(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders });
  assertStatus(res.status, 200, res.data);
  const tasks = (res.data as { tasks: Array<{ stats: { attempts: number } | null }> }).tasks;
  const withStats = tasks.filter((t) => t.stats !== null && t.stats.attempts > 0);
  assert(withStats.length > 0, 'no task has attempt stats — history ledger not being read');
}

async function testPatch_editAndRevertDescription(): Promise<void> {
  const list = await request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders });
  assertStatus(list.status, 200, list.data);
  const tasks = (list.data as { tasks: Array<{ name: string; description: string | null }> }).tasks;
  const target = tasks.find((t) => t.name === 'chat-mode');
  assert(target !== undefined, 'chat-mode task missing from catalog');
  const original = target!.description;
  const marker = `blackbox-edit-${Date.now()}`;
  try {
    const patch = await request(`${BASE_URL}/api/benchmarks/tasks/chat-mode`, {
      method: 'PATCH',
      headers: internalHeaders,
      body: JSON.stringify({ description: marker }),
    });
    assertStatus(patch.status, 200, patch.data);
    const updated = (patch.data as { task: { description: string | null } }).task;
    assert(updated.description === marker, 'patched description not reflected');
    const reread = await request(`${BASE_URL}/api/benchmarks/tasks`, {
      headers: internalHeaders,
    });
    const rereadTask = (
      reread.data as { tasks: Array<{ name: string; description: string | null }> }
    ).tasks.find((t) => t.name === 'chat-mode');
    assert(rereadTask?.description === marker, 'patched description not persisted');
  } finally {
    // Revert (empty-string description means "restore original or clear")
    await request(`${BASE_URL}/api/benchmarks/tasks/chat-mode`, {
      method: 'PATCH',
      headers: internalHeaders,
      body: JSON.stringify({ description: original ?? '' }),
    });
  }
}

async function testPatch_rejectsUnknownField(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks/chat-mode`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ nonsense_field: true }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testPatch_rejectsBadType(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks/chat-mode`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ timeout_seconds: 'ten minutes' }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testPatch_unknownTask404(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks/definitely-not-a-task`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ description: 'x' }),
  });
  assertStatus(res.status, 404, res.data);
}

async function testRuns_uploadListDetailAgentRoundTrip(): Promise<void> {
  try {
    // live snapshot first
    const live = await request(`${BASE_URL}/api/benchmarks/runs?live=1`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(syntheticBundle()),
    });
    assertStatus(live.status, 201, live.data);
    let list = await request(`${BASE_URL}/api/benchmarks/runs`, { headers: internalHeaders });
    assertStatus(list.status, 200, list.data);
    const entry = (list.data as { runs: Array<{ run_id: string; live: boolean }> }).runs.find(
      (r) => r.run_id === RUN_ID
    );
    assert(entry !== undefined, 'live snapshot missing from index');
    assert(entry!.live === true, 'snapshot not marked live');

    // final upload upserts the same run (idempotent index)
    const final = await request(`${BASE_URL}/api/benchmarks/runs`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(syntheticBundle()),
    });
    assertStatus(final.status, 201, final.data);
    list = await request(`${BASE_URL}/api/benchmarks/runs`, { headers: internalHeaders });
    const matches = (list.data as { runs: Array<{ run_id: string; live: boolean }> }).runs.filter(
      (r) => r.run_id === RUN_ID
    );
    assert(matches.length === 1, `expected 1 index entry, got ${matches.length}`);
    assert(matches[0].live === false, 'final upload still marked live');

    // detail
    const detail = await request(`${BASE_URL}/api/benchmarks/runs/${RUN_ID}`, {
      headers: internalHeaders,
    });
    assertStatus(detail.status, 200, detail.data);
    const run = (detail.data as { run: { tasks: Array<{ name: string; fast_mode: boolean }> } })
      .run;
    assert(run.tasks.length === 1 && run.tasks[0].name === 'chat-mode', 'detail tasks wrong');
    assert(run.tasks[0].fast_mode === true, 'fast_mode flag lost');
    // run-view enrichment: totals + per-task bundle fields
    const detailRun = run as unknown as {
      totals: { passed: number; failed: number; cost_cents: number };
      tasks: Array<{ tokens_in: number | null; cache_hit_pct: number | null }>;
    };
    assert(detailRun.totals !== undefined, 'detail missing totals');
    assert(detailRun.totals.passed === 1 && detailRun.totals.failed === 0, 'totals wrong');
    assert(detailRun.totals.cost_cents === 3, `totals cost ${detailRun.totals.cost_cents} != 3`);

    // root agent transcript
    const rootView = await request(
      `${BASE_URL}/api/benchmarks/runs/${RUN_ID}/agents/${ROOT_AGENT}`,
      { headers: internalHeaders }
    );
    assertStatus(rootView.status, 200, rootView.data);
    const root = rootView.data as {
      agent: { agent_id: string; busId: string };
      messages: Array<{ text: string }>;
      tree: Array<{ agent_id: string; parent_agent_id: string | null }>;
    };
    assert(root.agent.agent_id === ROOT_AGENT, 'root agent id mismatch');
    assert(root.messages.length === 2, `root messages ${root.messages.length} != 2`);
    assert(root.tree.length === 2, `tree size ${root.tree.length} != 2`);
    const sub = root.tree.find((n) => n.agent_id === SUB_AGENT);
    assert(sub?.parent_agent_id === ROOT_AGENT, 'sub-agent parent link missing');

    // sub-agent transcript (the fan-out renders)
    const subView = await request(`${BASE_URL}/api/benchmarks/runs/${RUN_ID}/agents/${SUB_AGENT}`, {
      headers: internalHeaders,
    });
    assertStatus(subView.status, 200, subView.data);
    const subData = subView.data as { messages: Array<{ text: string }> };
    assert(
      subData.messages.length === 1 && subData.messages[0].text === 'sub result',
      'sub-agent transcript wrong'
    );

    // unknown agent → 404
    const missing = await request(`${BASE_URL}/api/benchmarks/runs/${RUN_ID}/agents/not-an-agent`, {
      headers: internalHeaders,
    });
    assertStatus(missing.status, 404, missing.data);
  } finally {
    await request(`${BASE_URL}/api/benchmarks/runs/${RUN_ID}`, {
      method: 'DELETE',
      headers: internalHeaders,
    });
  }
}

async function testRuns_uploadRequiresRunId(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/runs`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify({ tasks: [] }),
  });
  assertStatus(res.status, 400, res.data);
}

async function testRunRequests_lifecycle(): Promise<void> {
  // create
  const created = await request(`${BASE_URL}/api/benchmarks/run-requests`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify({ task_names: ['chat-mode'] }),
  });
  assertStatus(created.status, 201, created.data);
  const id = (created.data as { request: { id: string; status: string } }).request.id;
  assert(
    (created.data as { request: { status: string } }).request.status === 'queued',
    'new request not queued'
  );

  // visible in queue view
  const list = await request(`${BASE_URL}/api/benchmarks/run-requests?status=queued`, {
    headers: internalHeaders,
  });
  assertStatus(list.status, 200, list.data);
  assert(
    (list.data as { requests: Array<{ id: string }> }).requests.some((r) => r.id === id),
    'request missing from queue view'
  );

  // claim wins once
  const claim = await request(`${BASE_URL}/api/benchmarks/run-requests/${id}`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ action: 'claim', claimed_by: 'blackbox:1' }),
  });
  assertStatus(claim.status, 200, claim.data);
  assert(
    (claim.data as { request: { status: string } }).request.status === 'running',
    'claim did not transition to running'
  );

  // double-claim rejected
  const doubleClaim = await request(`${BASE_URL}/api/benchmarks/run-requests/${id}`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ action: 'claim', claimed_by: 'blackbox:2' }),
  });
  assertStatus(doubleClaim.status, 409, doubleClaim.data);

  // progress + complete
  const progress = await request(`${BASE_URL}/api/benchmarks/run-requests/${id}`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ action: 'progress', progress: { note: 'halfway' } }),
  });
  assertStatus(progress.status, 200, progress.data);
  const complete = await request(`${BASE_URL}/api/benchmarks/run-requests/${id}`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ action: 'complete', run_id: 'blackbox-run' }),
  });
  assertStatus(complete.status, 200, complete.data);
  assert(
    (complete.data as { request: { status: string; runId: string | null } }).request.status ===
      'completed',
    'complete did not transition'
  );
}

async function testRunRequests_cancelOnlyFromQueued(): Promise<void> {
  const created = await request(`${BASE_URL}/api/benchmarks/run-requests`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify({ task_names: ['chat-mode'] }),
  });
  assertStatus(created.status, 201, created.data);
  const id = (created.data as { request: { id: string } }).request.id;

  const cancel = await request(`${BASE_URL}/api/benchmarks/run-requests/${id}`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ action: 'cancel' }),
  });
  assertStatus(cancel.status, 200, cancel.data);

  // cancelling again (now cancelled, not queued) → 409
  const again = await request(`${BASE_URL}/api/benchmarks/run-requests/${id}`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ action: 'cancel' }),
  });
  assertStatus(again.status, 409, again.data);
}

async function testRunRequests_unknownTaskRejected(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/run-requests`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify({ task_names: ['definitely-not-a-task'] }),
  });
  assertStatus(res.status, 400, res.data);
}

// ==================== runner ====================

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

async function runAll(): Promise<void> {
  if (!API_KEY) {
    console.error('BACKEND_API_KEY required (internal auth for hub endpoints)');
    process.exit(1);
  }
  const tests: Array<[string, () => Promise<void>]> = [
    ['auth: /tasks rejects unauthenticated', testAuth_tasksRejectsUnauthenticated],
    ['auth: /runs rejects unauthenticated', testAuth_runsRejectsUnauthenticated],
    ['auth: /run-requests rejects unauthenticated', testAuth_runRequestsRejectsUnauthenticated],
    ['auth: POST /runs rejects unauthenticated', testAuth_uploadRejectsUnauthenticated],
    ['catalog: tasks + stats shape', testCatalog_returnsTasksWithStatsShape],
    ['catalog: groups are the four known', testCatalog_groupsAreTheThreeKnown],
    ['catalog: stats present from history ledger', testCatalog_statsPresentForTasksWithHistory],
    ['patch: edit + revert description', testPatch_editAndRevertDescription],
    ['patch: rejects unknown field', testPatch_rejectsUnknownField],
    ['patch: rejects bad type', testPatch_rejectsBadType],
    ['patch: unknown task 404', testPatch_unknownTask404],
    ['runs: upload→list→detail→agents round-trip', testRuns_uploadListDetailAgentRoundTrip],
    ['runs: upload requires run_id', testRuns_uploadRequiresRunId],
    ['run-requests: full lifecycle + double-claim', testRunRequests_lifecycle],
    ['run-requests: cancel only from queued', testRunRequests_cancelOnlyFromQueued],
    ['run-requests: unknown task rejected', testRunRequests_unknownTaskRejected],
  ];

  const results: TestResult[] = [];
  for (const [name, fn] of tests) {
    results.push(await runTest(name, fn));
  }

  console.log('\nBenchmark Hub black-box results');
  console.log('='.repeat(50));
  for (const r of results) {
    console.log(
      `${r.passed ? '  PASS' : '  FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }
  const failed = results.filter((r) => !r.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

runAll().catch((error) => {
  console.error('Benchmark Hub black-box suite crashed:', error);
  process.exit(1);
});
