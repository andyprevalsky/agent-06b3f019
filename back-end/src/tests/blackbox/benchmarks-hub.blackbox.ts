#!/usr/bin/env tsx
/**
 * Black-box tests for the Benchmark Hub endpoints (/api/benchmarks/*)
 *
 * Domain surface:
 *   GET    /api/benchmarks/tasks                    — team-gated catalog (tasks.json) + per-task stats
 *   PATCH  /api/benchmarks/tasks/:name              — disabled (405; edit tasks.json)
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
 *   - validation: run requests reject unknown task names; invalid group
 *     schedules are a permanent 400 (never a retryable 500)
 *   - idempotency: re-uploading a bundle upserts (single index entry)
 *   - catalog: hub + public routes serve tasks.json even when DB rows are stale
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { z } from 'zod';
import {
  assertEnvironmentReconcileFromFile,
  assertInvalidGroupScheduleIsPermanent400,
  assertToastPromptMigration,
  syntheticBenchmarkBundle,
} from './benchmarks-hub.testkit';

const REPO_ROOT = resolve(__dirname, '../../../../');

function readTasksJson(): unknown {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'agents/benchmarks/tasks.json'), 'utf8'));
}

config();

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
      last_five_passed: z.boolean().optional(),
    })
    .nullable(),
});

// ==================== synthetic run bundle ====================

const RUN_ID = `blackbox-hub-${process.pid}-${Date.now()}`;
const ROOT_AGENT = `bb-root-${process.pid}`;
const SUB_AGENT = `bb-sub-${process.pid}`;

function syntheticBundle(): Record<string, unknown> {
  return syntheticBenchmarkBundle(RUN_ID, ROOT_AGENT, SUB_AGENT);
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

async function testCatalog_groupsAreLabelDriven(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders });
  assertStatus(res.status, 200, res.data);
  const tasks = (res.data as { tasks: Array<{ name: string; group: string }> }).tasks;
  const groups = new Set(tasks.map((t) => t.group));
  for (const g of groups) {
    assert(
      ['pre-deploy', 'daily', 'rose-bench', 'polar-bench', 'incomplete'].includes(g),
      `unexpected group: ${g}`
    );
  }
  // Grouping is driven off the stored `group` label in tasks.json; every ready
  // runnable bucket must be represented (proves the label resolves, not just
  // the smoke gate).
  assert(groups.has('pre-deploy'), 'no pre-deploy (smoke) tasks found');
  assert(groups.has('daily'), 'no daily tasks found');
  assert(groups.has('rose-bench'), 'no rose-bench tasks found');
  assert(groups.has('polar-bench'), 'no polar-bench tasks found');
  const polarTask = tasks.find((task) => task.group === 'polar-bench');
  assert(polarTask, 'expected at least one polar-bench catalog task');
  assert(
    polarTask.name.startsWith('polar-'),
    `polar-bench task name should be polar-*: ${polarTask.name}`
  );
  // Every task must carry a resolvable group (label or derived fallback).
  for (const t of tasks) {
    assert(typeof t.group === 'string' && t.group.length > 0, `task ${t.name} has no group`);
  }
  const messagePerson = tasks.find((task) => task.name === 'message-person');
  assert(messagePerson, 'message-person missing from benchmark catalog');
  assert(
    messagePerson.group === 'daily',
    `message-person must be daily, got ${messagePerson.group}`
  );
}

async function testCatalog_hubMatchesTasksJsonGroup(): Promise<void> {
  const fileTasks = readTasksJson() as Array<{ name: string; group?: string }>;
  const fileTask = fileTasks.find((task) => task.name === 'message-person');
  assert(fileTask !== undefined, 'message-person missing from tasks.json');
  const res = await request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders });
  assertStatus(res.status, 200, res.data);
  const tasks = (res.data as { tasks: Array<{ name: string; group: string }> }).tasks;
  const messagePerson = tasks.find((task) => task.name === 'message-person');
  assert(messagePerson, 'message-person missing from benchmark catalog');
  const expectedGroup = (fileTask.group ?? 'daily').toLowerCase().replace(/[\s_]+/g, '-');
  assert(
    messagePerson.group === expectedGroup,
    `message-person group ${messagePerson.group} != tasks.json group ${expectedGroup}`
  );
}

async function testCatalog_fileWinsOverStaleDb(): Promise<void> {
  const fileTasks = readTasksJson() as Array<{ name: string; prompt: string }>;
  const fileTask = fileTasks.find((task) => task.name === 'chat-mode');
  assert(fileTask !== undefined, 'chat-mode missing from tasks.json');
  const prisma = new PrismaClient();
  try {
    const current = await prisma.benchmarkTask.findUnique({ where: { name: 'chat-mode' } });
    assert(current, 'chat-mode missing from DB');
    const stalePrompt = `stale-db-prompt-${Date.now()}`;
    const staleDefinition = {
      ...(current.definition as Record<string, unknown>),
      prompt: stalePrompt,
    };
    await prisma.benchmarkTask.update({
      where: { name: 'chat-mode' },
      data: {
        prompt: stalePrompt,
        definition: staleDefinition as Prisma.InputJsonObject,
      },
    });

    const [publicRes, hubRes, pickerRes] = await Promise.all([
      request(`${BASE_URL}/api/benchmarks`),
      request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders }),
      request(`${BASE_URL}/api/benchmarks/test-prompts`),
    ]);
    assertStatus(publicRes.status, 200, publicRes.data);
    assertStatus(hubRes.status, 200, hubRes.data);
    assertStatus(pickerRes.status, 200, pickerRes.data);

    const publicTask = (
      publicRes.data as { tasks: Array<{ name: string; prompt: string }> }
    ).tasks.find((task) => task.name === 'chat-mode');
    const hubTask = (hubRes.data as { tasks: Array<{ name: string; prompt: string }> }).tasks.find(
      (task) => task.name === 'chat-mode'
    );
    const pickerPrompt = (
      pickerRes.data as { prompts: Array<{ title: string; prompt: string }> }
    ).prompts.find((prompt) => prompt.title === 'Basic Chat Response');

    assert(publicTask?.prompt === fileTask.prompt, 'public catalog served stale DB prompt');
    assert(hubTask?.prompt === fileTask.prompt, 'hub catalog served stale DB prompt');
    assert(pickerPrompt?.prompt === fileTask.prompt, 'test-prompts served stale DB prompt');
  } finally {
    const { seedBenchmarkTasks } = await import('../../domains/benchmarks/hubCatalogSeed');
    await seedBenchmarkTasks();
    await prisma.$disconnect();
  }
}

async function testCatalog_toastPromptMigrationUpdatesColumnDefinitionAndHub(): Promise<void> {
  await assertToastPromptMigration(BASE_URL, internalHeaders);
}

async function testCatalog_seedReconcilesEnvironmentFromFile(): Promise<void> {
  await assertEnvironmentReconcileFromFile();
}

async function testCatalog_statsPresentForTasksWithHistory(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders });
  assertStatus(res.status, 200, res.data);
  const tasks = (res.data as { tasks: Array<{ stats: { attempts: number } | null }> }).tasks;
  const withStats = tasks.filter((t) => t.stats !== null && t.stats.attempts > 0);
  assert(withStats.length > 0, 'no task has attempt stats — history ledger not being read');
}

async function testCatalog_retiredTasksInvisible(): Promise<void> {
  // 'retired' keeps a task's name alive for ledger integrity but it must never
  // surface: not in the hub catalog, not in the query-box picker.
  const catalog = await request(`${BASE_URL}/api/benchmarks/tasks`, { headers: internalHeaders });
  assertStatus(catalog.status, 200, catalog.data);
  const names = (catalog.data as { tasks: Array<{ name: string }> }).tasks.map((t) => t.name);
  assert(!names.includes('load-test-sias'), 'retired task leaked into the hub catalog');

  const picker = await request(`${BASE_URL}/api/benchmarks/test-prompts`);
  assertStatus(picker.status, 200, picker.data);
  const titles = (picker.data as { prompts: Array<{ title: string }> }).prompts.map((p) => p.title);
  assert(
    !titles.some((t) => t.includes('Load-Test: Fan Out N')),
    'retired task leaked into the query-box picker'
  );
}

async function testPatch_rejectsEdits(): Promise<void> {
  const res = await request(`${BASE_URL}/api/benchmarks/tasks/chat-mode`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ description: 'blocked-edit' }),
  });
  assertStatus(res.status, 405, res.data);
  const body = res.data as { error?: string };
  assert(
    typeof body.error === 'string' && body.error.includes('read-only'),
    'PATCH should explain tasks.json is the source of truth'
  );
}

async function testRuns_uploadListDetailAgentRoundTrip(): Promise<void> {
  try {
    // The evaluated verdict is visible while resource release is still pending.
    const liveBundle = syntheticBundle();
    const liveTasks = liveBundle.tasks as Array<Record<string, unknown>>;
    liveTasks[0].lifecycle_stage = 'evaluated';
    liveTasks[0].startup_label = 'Loading services';
    // live snapshot first
    const live = await request(`${BASE_URL}/api/benchmarks/runs?live=1`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(liveBundle),
    });
    assertStatus(live.status, 201, live.data);
    let list = await request(`${BASE_URL}/api/benchmarks/runs`, { headers: internalHeaders });
    assertStatus(list.status, 200, list.data);
    const entry = (list.data as { runs: Array<{ run_id: string; live: boolean }> }).runs.find(
      (r) => r.run_id === RUN_ID
    );
    assert(entry !== undefined, 'live snapshot missing from index');
    assert(entry!.live === true, 'snapshot not marked live');
    const evaluated = await request(`${BASE_URL}/api/benchmarks/runs/${RUN_ID}`, {
      headers: internalHeaders,
    });
    const first = (
      evaluated.data as {
        run: { tasks: Array<{ lifecycle_stage?: string; startup_label?: string }> };
      }
    ).run.tasks[0];
    assert(first.lifecycle_stage === 'evaluated', 'live lifecycle stage was discarded');
    assert(first.startup_label === 'Loading services', 'live startup label was discarded');

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
      tree: Array<{
        agent_id: string;
        parent_agent_id: string | null;
        message_count: number;
        status: string;
      }>;
    };
    assert(root.agent.agent_id === ROOT_AGENT, 'root agent id mismatch');
    assert(root.messages.length === 2, `root messages ${root.messages.length} != 2`);
    assert(root.tree.length === 2, `tree size ${root.tree.length} != 2`);
    const sub = root.tree.find((n) => n.agent_id === SUB_AGENT);
    assert(sub?.parent_agent_id === ROOT_AGENT, 'sub-agent parent link missing');
    assert((sub?.message_count ?? 0) > 0, 'sub-agent tree node must carry a transcript');
    assert(sub?.status === 'COMPLETED', `sub-agent status ${sub?.status} != COMPLETED`);

    // sub-agent transcript (the fan-out renders)
    const subView = await request(`${BASE_URL}/api/benchmarks/runs/${RUN_ID}/agents/${SUB_AGENT}`, {
      headers: internalHeaders,
    });
    assertStatus(subView.status, 200, subView.data);
    const subData = subView.data as {
      messages: Array<{ text: string }>;
      agent: { parent_agent_id: string | null; parent_goal: string | null };
    };
    assert(
      subData.messages.length === 1 && subData.messages[0].text === 'sub result',
      'sub-agent transcript wrong'
    );
    assert(subData.agent.parent_agent_id === ROOT_AGENT, 'hub sub-agent parent_agent_id missing');
    assert(
      subData.agent.parent_goal === 'hub blackbox goal',
      `hub sub-agent parent_goal ${String(subData.agent.parent_goal)} != hub blackbox goal`
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

async function testRuns_blankAgentIdNormalizesToNull(): Promise<void> {
  const runId = `${RUN_ID}-blank-agent`;
  const bundle = syntheticBundle();
  bundle.run_id = runId;
  const tasks = bundle.tasks as Array<Record<string, unknown>>;
  tasks[0].agent_id = '   ';

  try {
    const upload = await request(`${BASE_URL}/api/benchmarks/runs?live=1`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(bundle),
    });
    assertStatus(upload.status, 201, upload.data);

    const list = await request(`${BASE_URL}/api/benchmarks/runs`, { headers: internalHeaders });
    assertStatus(list.status, 200, list.data);
    const entry = (
      list.data as { runs: Array<{ run_id: string; tasks: Array<{ agent_id: string | null }> }> }
    ).runs.find((run) => run.run_id === runId);
    assert(entry !== undefined, 'blank-agent run missing from index');
    assert(entry.tasks[0].agent_id === null, 'blank agent id must normalize to null');
  } finally {
    await request(`${BASE_URL}/api/benchmarks/runs/${runId}`, {
      method: 'DELETE',
      headers: internalHeaders,
    });
  }
}

async function testAgents_mainPanelFallbackServesBenchmarkAgents(): Promise<void> {
  try {
    const upload = await request(`${BASE_URL}/api/benchmarks/runs`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(syntheticBundle()),
    });
    assertStatus(upload.status, 201, upload.data);

    // normal agent detail route serves the archived benchmark agent
    const detail = await request(`${BASE_URL}/api/agents/${ROOT_AGENT}`, {
      headers: internalHeaders,
    });
    assertStatus(detail.status, 200, detail.data);
    const agentData = detail.data as {
      agent: { agent_id: string; busId?: string };
      messages: Array<{ text: string }>;
    };
    assert(agentData.agent.agent_id === ROOT_AGENT, 'fallback agent id mismatch');
    assert(agentData.messages.length === 2, 'fallback messages missing');

    // normal tree route serves the fan-out (root + sub-agent)
    const tree = await request(`${BASE_URL}/api/agents/tree?busId=${ROOT_AGENT}`, {
      headers: internalHeaders,
    });
    assertStatus(tree.status, 200, tree.data);
    const ids = (
      tree.data as { agents: Array<{ agent_id: string; message_count: number; status: string }> }
    ).agents.map((a) => a.agent_id);
    assert(ids.includes(ROOT_AGENT) && ids.includes(SUB_AGENT), `tree fallback wrong: ${ids}`);
    const subNode = (
      tree.data as { agents: Array<{ agent_id: string; message_count: number; status: string }> }
    ).agents.find((a) => a.agent_id === SUB_AGENT);
    assert((subNode?.message_count ?? 0) > 0, 'tree fallback child must not be spinning-up empty');
    assert(subNode?.status === 'COMPLETED', 'tree fallback child status');

    // sub-agent transcript through the normal route too
    const sub = await request(`${BASE_URL}/api/agents/${SUB_AGENT}`, {
      headers: internalHeaders,
    });
    assertStatus(sub.status, 200, sub.data);
    const subBody = sub.data as { messages: Array<{ text: string }> };
    assert((subBody.messages?.length ?? 0) > 0, 'sub-agent fallback transcript missing');
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
    body: JSON.stringify({ task_names: ['chat-mode'], scope: `blackbox-${process.pid}` }),
  });
  assertStatus(created.status, 201, created.data);
  const createdRequest = (
    created.data as { request: { id: string; status: string; runId: string | null } }
  ).request;
  const id = createdRequest.id;
  assert(createdRequest.status === 'queued', 'new request not queued');
  // INVARIANT: dispatched runs always link to a run dashboard immediately.
  assert(createdRequest.runId === `hub-${id}`, `dispatch not linked: ${createdRequest.runId}`);
  const placeholder = await request(`${BASE_URL}/api/benchmarks/runs/hub-${id}`, {
    headers: internalHeaders,
  });
  assertStatus(placeholder.status, 200, placeholder.data);
  assert(
    (placeholder.data as { run: { live: boolean; tasks: Array<{ status: string }> } }).run.tasks[0]
      .status === 'queued',
    'placeholder run not queued'
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
  await request(`${BASE_URL}/api/benchmarks/runs/hub-${id}`, {
    method: 'DELETE',
    headers: internalHeaders,
  });
}

async function testRunRequests_cancelOnlyFromQueued(): Promise<void> {
  const created = await request(`${BASE_URL}/api/benchmarks/run-requests`, {
    method: 'POST',
    headers: internalHeaders,
    body: JSON.stringify({ task_names: ['chat-mode'], scope: `blackbox-${process.pid}` }),
  });
  assertStatus(created.status, 201, created.data);
  const id = (created.data as { request: { id: string } }).request.id;

  const cancel = await request(`${BASE_URL}/api/benchmarks/run-requests/${id}`, {
    method: 'PATCH',
    headers: internalHeaders,
    body: JSON.stringify({ action: 'cancel' }),
  });
  assertStatus(cancel.status, 200, cancel.data);
  // the placeholder dashboard is removed with the cancellation
  const gone = await request(`${BASE_URL}/api/benchmarks/runs/hub-${id}`, {
    headers: internalHeaders,
  });
  assertStatus(gone.status, 404, gone.data);

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
    ['catalog: groups are label-driven', testCatalog_groupsAreLabelDriven],
    ['catalog: hub group matches tasks.json', testCatalog_hubMatchesTasksJsonGroup],
    ['catalog: hub serves tasks.json over stale DB rows', testCatalog_fileWinsOverStaleDb],
    [
      'catalog: Toast prompt comes from tasks.json',
      testCatalog_toastPromptMigrationUpdatesColumnDefinitionAndHub,
    ],
    [
      'catalog: seed syncs environment from tasks.json into DB',
      testCatalog_seedReconcilesEnvironmentFromFile,
    ],
    ['catalog: stats present from history ledger', testCatalog_statsPresentForTasksWithHistory],
    ['catalog: retired tasks invisible everywhere', testCatalog_retiredTasksInvisible],
    ['patch: task edits rejected (read-only catalog)', testPatch_rejectsEdits],
    ['runs: upload→list→detail→agents round-trip', testRuns_uploadListDetailAgentRoundTrip],
    ['runs: blank agent ids normalize to null', testRuns_blankAgentIdNormalizesToNull],
    ['runs: upload requires run_id', testRuns_uploadRequiresRunId],
    [
      'runs: invalid group schedule is a permanent 400',
      () => assertInvalidGroupScheduleIsPermanent400(BASE_URL, internalHeaders),
    ],
    [
      'agents API fallback: benchmark agents open in the main panel',
      testAgents_mainPanelFallbackServesBenchmarkAgents,
    ],
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
