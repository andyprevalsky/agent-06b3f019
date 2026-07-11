import { readTasksFile } from './config';
import { createLogger } from '../../providers/logger';

const log = createLogger('Benchmarks');

// Read once at startup — task definitions are static
let cachedTasks: unknown[] | null = null;
try {
  const parsed = readTasksFile();
  if (!Array.isArray(parsed)) {
    log.error('Benchmark tasks file is not an array');
  } else {
    // tasks.json entries are keyed by `name` and `prompt` (mirrors
    // benchmarks.blackbox.ts BenchmarkTaskSchema). The earlier `id`/`goal`
    // validator never matched any entry, which silently turned the route into
    // a permanent 500 — fix is to validate the actual shape.
    const valid = parsed.every(
      (t: unknown) =>
        typeof t === 'object' &&
        t !== null &&
        'name' in t &&
        'prompt' in t &&
        typeof (t as Record<string, unknown>).name === 'string' &&
        typeof (t as Record<string, unknown>).prompt === 'string'
    );
    if (!valid) {
      log.error('Benchmark tasks file contains malformed entries');
    } else {
      cachedTasks = parsed;
    }
  }
} catch (err) {
  log.error('Failed to load benchmark tasks at startup', {
    error: err instanceof Error ? err.message : String(err),
  });
}

export class TasksUnavailableError extends Error {
  constructor() {
    super('Benchmark tasks unavailable');
  }
}

/**
 * Returns all benchmark task definitions.
 * Throws TasksUnavailableError if tasks.json failed to load at startup.
 */
export function getTasks(): unknown[] {
  if (!cachedTasks) {
    throw new TasksUnavailableError();
  }
  return cachedTasks;
}

export interface TestPrompt {
  title: string;
  description: string;
  prompt: string;
  attachmentUrls: string[];
  tags: string[];
}

interface CatalogTaskShape {
  title?: unknown;
  description?: unknown;
  prompt: string;
  attachment?: unknown;
  attachments?: unknown;
  runner?: unknown;
  tags?: unknown;
}

/**
 * Adapts the benchmark catalog into the shape the front-end test-prompts
 * picker consumes. This is the single source the query box reads from, so the
 * picker can never drift from the eval catalog.
 *
 * - Only agent-runner entries are included (external vitest smokes are not
 *   agent goals).
 * - `{frontend_url}` (run_benchmark's token) is rewritten to the front-end's
 *   `{{TEST_PAYMENT_BASE_URL}}` token, which TestPromptsSelector resolves to
 *   the live tunnel URL.
 * - Bare attachment names become `/test-assets/*` public paths.
 * - Catalog `tags` pass through so the picker can filter prompts by tag.
 */
export function getTestPrompts(): TestPrompt[] {
  return (getTasks() as CatalogTaskShape[])
    .filter((task) => (task.runner ?? 'agent') === 'agent')
    .map((task) => {
      const attachments = Array.isArray(task.attachments)
        ? (task.attachments as string[])
        : typeof task.attachment === 'string'
          ? [task.attachment]
          : [];
      const title = typeof task.title === 'string' ? task.title : '';
      return {
        title,
        description: typeof task.description === 'string' ? task.description : title,
        prompt: task.prompt.replaceAll('{frontend_url}', '{{TEST_PAYMENT_BASE_URL}}'),
        attachmentUrls: attachments.map((name) => `/test-assets/${name}`),
        tags: Array.isArray(task.tags)
          ? (task.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
          : [],
      };
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Benchmark Hub: SQL-backed task catalog + stats, task edits, run dispatch
// ═══════════════════════════════════════════════════════════════════════════

import { z } from 'zod';
import { readTaskAttempts } from './config';
import * as hubStore from '../../providers/benchmarkHubStore';
import * as repo from './repo';

interface RawTask extends Record<string, unknown> {
  name: string;
  prompt: string;
}

function taskColumns(task: RawTask) {
  const env = task.environment as Record<string, unknown> | undefined;
  return {
    title: typeof task.title === 'string' ? task.title : null,
    prompt: task.prompt,
    status: typeof task.status === 'string' ? task.status : null,
    bench: typeof task.bench === 'string' ? task.bench : null,
    runner: typeof task.runner === 'string' ? task.runner : null,
    tags: Array.isArray(task.tags) ? (task.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    timeoutSeconds: typeof task.timeout_seconds === 'number' ? task.timeout_seconds : null,
    priceLimitCents: typeof task.price_limit_cents === 'number' ? task.price_limit_cents : null,
    expectedTools: Array.isArray(task.expected_tools)
      ? (task.expected_tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    minAgentCount: typeof task.min_agent_count === 'number' ? task.min_agent_count : null,
    isChatMode: task.is_chat_mode === true,
    environment: (env ?? undefined) as repo.JsonInput | undefined,
    evaluators: (task.evaluators ?? undefined) as repo.JsonInput | undefined,
    source: (task.source ?? undefined) as repo.JsonInput | undefined,
    definition: task as repo.JsonInput,
  };
}

/**
 * Seed the BenchmarkTask table from tasks.json: INSERT missing names only.
 * The DB is the source of truth after seeding — file entries never overwrite
 * rows, so hub edits survive redeploys while new catalog entries added via
 * git still show up.
 */
export async function seedBenchmarkTasks(): Promise<{ inserted: number; total: number }> {
  const tasks = (cachedTasks ?? []) as RawTask[];
  if (tasks.length === 0) return { inserted: 0, total: 0 };
  const known = new Set(await repo.findExistingTaskNames());
  let inserted = 0;
  for (const task of tasks) {
    if (typeof task.name !== 'string' || known.has(task.name)) continue;
    await repo.createTask({ name: task.name, ...taskColumns(task) });
    inserted += 1;
  }
  log.info('Benchmark task seed complete', { inserted, total: known.size + inserted });
  // Public catalog routes serve DB truth once seeded (edits included).
  await refreshTasksFromDb();
  return { inserted, total: known.size + inserted };
}

/** Replace the in-memory public catalog cache with DB definitions. */
export async function refreshTasksFromDb(): Promise<void> {
  const rows = await repo.findAllTasks();
  if (rows.length > 0) {
    cachedTasks = rows.map((r) => r.definition as Record<string, unknown>);
  }
}

export interface TaskStats {
  attempts: number;
  passes: number;
  pass_rate: number | null;
  p50_duration_seconds: number | null;
  p95_duration_seconds: number | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_fast_mode: boolean;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Per-task attempt stats: committed history ledger merged with hub-uploaded
 * run results (which cover runs after the last deploy/commit).
 */
export async function computeTaskStats(): Promise<Map<string, TaskStats>> {
  interface Sample {
    passed: boolean;
    status: string;
    duration: number | null;
    fastMode: boolean;
    timestamp: string;
  }
  const samples = new Map<string, Sample[]>();
  const push = (task: string, s: Sample) => {
    const list = samples.get(task) ?? [];
    list.push(s);
    samples.set(task, list);
  };
  for (const a of readTaskAttempts()) {
    push(a.task, {
      passed: a.passed,
      status: a.status,
      duration: a.duration_seconds,
      fastMode: a.fast_mode_cache,
      timestamp: a.timestamp,
    });
  }
  for (const run of await hubStore.listRuns()) {
    if (run.live) continue; // only completed runs count toward stats
    for (const t of run.tasks) {
      push(t.name, {
        passed: t.passed === true,
        status: t.status,
        duration: t.duration_seconds,
        fastMode: t.fast_mode,
        timestamp: run.timestamp,
      });
    }
  }
  const stats = new Map<string, TaskStats>();
  for (const [task, list] of samples) {
    list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const passes = list.filter((s) => s.passed);
    const passDurations = passes
      .map((s) => s.duration)
      .filter((d): d is number => typeof d === 'number')
      .sort((a, b) => a - b);
    const last = list[list.length - 1];
    stats.set(task, {
      attempts: list.length,
      passes: passes.length,
      pass_rate: list.length > 0 ? Math.round((passes.length / list.length) * 1000) / 1000 : null,
      p50_duration_seconds: percentile(passDurations, 0.5),
      p95_duration_seconds: percentile(passDurations, 0.95),
      last_attempt_at: last?.timestamp || null,
      last_status: last?.status ?? null,
      last_fast_mode: last?.fastMode === true,
    });
  }
  return stats;
}

const READY_STATUSES = new Set(['ready']);

/**
 * The four catalog groups (matches how the suites actually run):
 *   incomplete — not runnable (missing fixtures/judges; excluded from suites)
 *   pre-deploy — the `smoke` tag set (`run_benchmark.py --suite smoke`, the
 *                gate /deploy and scripts/test.sh run before merging)
 *   rose-bench — harness-independent capability benches (bench field)
 *   daily      — every other ready pipeline-e2e task (the broad eval suite)
 */
function taskGroup(status: string | null, bench: string | null, tags: string[]): string {
  if (status !== null && !READY_STATUSES.has(status)) return 'incomplete';
  if (tags.includes('smoke')) return 'pre-deploy';
  if (bench === 'rose-bench') return 'rose-bench';
  return 'daily';
}

export interface CatalogTask {
  name: string;
  title: string | null;
  description: string | null;
  prompt: string;
  status: string | null;
  bench: string | null;
  group: string;
  tags: string[];
  timeout_seconds: number | null;
  price_limit_cents: number | null;
  expected_tools: string[];
  min_agent_count: number | null;
  is_chat_mode: boolean;
  world_model_mode: string | null;
  updated_at: string;
  updated_by: string | null;
  stats: TaskStats | null;
}

/** The hub catalog: every task from the DB, joined with attempt stats. */
export async function getCatalog(): Promise<CatalogTask[]> {
  const [rows, stats] = await Promise.all([repo.findAllTasks(), computeTaskStats()]);
  return rows.map((row) => {
    const definition = (row.definition ?? {}) as Record<string, unknown>;
    const env = (row.environment ?? {}) as Record<string, unknown>;
    const worldModelMode =
      typeof env.mode === 'string'
        ? env.mode
        : typeof definition.world_model_mode === 'string'
          ? definition.world_model_mode
          : null;
    return {
      name: row.name,
      title: row.title,
      description: typeof definition.description === 'string' ? definition.description : null,
      prompt: row.prompt,
      status: row.status,
      bench: row.bench,
      group: taskGroup(row.status, row.bench, row.tags),
      tags: row.tags,
      timeout_seconds: row.timeoutSeconds,
      price_limit_cents: row.priceLimitCents,
      expected_tools: row.expectedTools,
      min_agent_count: row.minAgentCount,
      is_chat_mode: row.isChatMode,
      world_model_mode: worldModelMode,
      updated_at: row.updatedAt.toISOString(),
      updated_by: row.updatedBy,
      stats: stats.get(row.name) ?? null,
    };
  });
}

export const taskEditSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    prompt: z.string().min(1).optional(),
    tags: z.array(z.string().min(1).max(60)).max(30).optional(),
    status: z.enum(['ready', 'incomplete']).nullable().optional(),
    bench: z.enum(['rose-bench', 'pipeline-e2e']).optional(),
    timeout_seconds: z.number().int().positive().max(86_400).optional(),
    price_limit_cents: z.number().int().min(0).max(1_000_000).optional(),
    expected_tools: z.array(z.string().min(1).max(120)).max(50).optional(),
    min_agent_count: z.number().int().min(0).max(10_000).nullable().optional(),
    is_chat_mode: z.boolean().optional(),
  })
  .strict();

export type TaskEdit = z.infer<typeof taskEditSchema>;

export class TaskNotFoundError extends Error {}

/**
 * Apply a validated metadata edit to a task: columns AND the stored
 * definition JSON stay in sync (the definition is what runners execute after
 * the poller exports the catalog back to tasks.json).
 */
export async function patchTask(
  name: string,
  edit: TaskEdit,
  editedBy: string
): Promise<CatalogTask> {
  const row = await repo.findTaskByName(name);
  if (!row) throw new TaskNotFoundError(name);
  const definition = { ...((row.definition ?? {}) as Record<string, unknown>) };
  const data: repo.BenchmarkTaskUpdate = { updatedBy: editedBy };

  if (edit.title !== undefined) {
    data.title = edit.title;
    definition.title = edit.title;
  }
  if (edit.description !== undefined) definition.description = edit.description;
  if (edit.prompt !== undefined) {
    data.prompt = edit.prompt;
    definition.prompt = edit.prompt;
  }
  if (edit.tags !== undefined) {
    data.tags = edit.tags;
    definition.tags = edit.tags;
  }
  if (edit.status !== undefined) {
    data.status = edit.status;
    if (edit.status === null) delete definition.status;
    else definition.status = edit.status;
  }
  if (edit.bench !== undefined) {
    data.bench = edit.bench;
    definition.bench = edit.bench;
  }
  if (edit.timeout_seconds !== undefined) {
    data.timeoutSeconds = edit.timeout_seconds;
    definition.timeout_seconds = edit.timeout_seconds;
  }
  if (edit.price_limit_cents !== undefined) {
    data.priceLimitCents = edit.price_limit_cents;
    definition.price_limit_cents = edit.price_limit_cents;
  }
  if (edit.expected_tools !== undefined) {
    data.expectedTools = edit.expected_tools;
    definition.expected_tools = edit.expected_tools;
  }
  if (edit.min_agent_count !== undefined) {
    data.minAgentCount = edit.min_agent_count;
    if (edit.min_agent_count === null) delete definition.min_agent_count;
    else definition.min_agent_count = edit.min_agent_count;
  }
  if (edit.is_chat_mode !== undefined) {
    data.isChatMode = edit.is_chat_mode;
    definition.is_chat_mode = edit.is_chat_mode;
  }
  data.definition = definition as repo.JsonInput;

  await repo.updateTask(name, data);
  await refreshTasksFromDb();
  const catalog = await getCatalog();
  const updated = catalog.find((t) => t.name === name);
  if (!updated) throw new TaskNotFoundError(name);
  return updated;
}

// ── Run requests (hub dispatch queue) ────────────────────────────────────────

export const runRequestSchema = z
  .object({
    task_names: z.array(z.string().min(1)).min(1).max(50),
    sim_on: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

export class UnknownTasksError extends Error {
  constructor(public readonly unknown: string[]) {
    super(`Unknown tasks: ${unknown.join(', ')}`);
  }
}

export async function createRunRequest(
  input: z.infer<typeof runRequestSchema>,
  requestedBy: string
) {
  const known = new Set(await repo.findExistingTaskNames(input.task_names));
  const unknown = input.task_names.filter((n) => !known.has(n));
  if (unknown.length > 0) throw new UnknownTasksError(unknown);
  const request = await repo.createRunRequestRow({
    taskNames: input.task_names,
    simOn: input.sim_on ?? [],
    requestedBy,
  });
  // INVARIANT: every dispatched run links to a run dashboard from the moment
  // it exists. Create the placeholder run (queued tasks) under the same
  // hub-<request-id> the poller streams to; snapshots/final upserts replace it.
  const runId = `hub-${request.id}`;
  await hubStore.putRun(
    {
      run_id: runId,
      timestamp: new Date().toISOString(),
      suite: 'hub-dispatch',
      source: 'hub-dispatch',
      tasks: input.task_names.map((name) => ({ name, status: 'queued' })),
    },
    { live: true }
  );
  return repo.updateRunRequestRow(request.id, { runId });
}

export async function listRunRequests(statuses?: string[]) {
  return repo.listRunRequestRows(statuses);
}

/** Atomic queued→running claim; only one poller can win a request. */
export async function claimRunRequest(id: string, claimedBy: string) {
  const claimed = await repo.transitionQueuedToRunning(id, claimedBy);
  if (!claimed) return null;
  return repo.findRunRequest(id);
}

export const runRequestUpdateSchema = z
  .object({
    action: z.enum(['claim', 'progress', 'complete', 'fail', 'cancel']),
    claimed_by: z.string().min(1).max(200).optional(),
    progress: z.unknown().optional(),
    run_id: z.string().min(1).max(200).optional(),
    error: z.string().max(4000).optional(),
  })
  .strict();

export async function updateRunRequest(
  id: string,
  update: z.infer<typeof runRequestUpdateSchema>
) {
  if (update.action === 'claim') {
    return claimRunRequest(id, update.claimed_by ?? 'unknown');
  }
  const existing = await repo.findRunRequest(id);
  if (existing === null) return null;
  if (update.action === 'progress') {
    return repo.updateRunRequestRow(id, {
      progress: (update.progress ?? {}) as repo.JsonInput,
      ...(update.run_id ? { runId: update.run_id } : {}),
    });
  }
  if (update.action === 'complete') {
    return repo.updateRunRequestRow(id, {
      status: 'completed',
      ...(update.run_id ? { runId: update.run_id } : {}),
    });
  }
  if (update.action === 'fail') {
    const failed = await repo.updateRunRequestRow(id, {
      status: 'failed',
      error: update.error ?? 'unknown failure',
    });
    // Keep the linked run dashboard truthful: mark still-pending placeholder
    // tasks failed with the dispatch error (real uploaded results are kept).
    if (failed.runId !== null) {
      const bundle = await hubStore.getRunBundle(failed.runId);
      if (bundle !== null && Array.isArray(bundle.tasks)) {
        const tasks = (bundle.tasks as Array<Record<string, unknown>>).map((t) =>
          t.passed === undefined && t.agent_id === undefined
            ? { ...t, status: 'failed', passed: false, failure_reason: update.error ?? 'dispatch failed' }
            : t
        );
        await hubStore.putRun({ ...bundle, tasks }, { live: false });
      }
    }
    return failed;
  }
  // cancel: only queued requests can be cancelled (a running claim owns it)
  const cancelled = await repo.transitionQueuedToCancelled(id);
  if (!cancelled) return null;
  const row = await repo.findRunRequest(id);
  if (row !== null && row.runId !== null) {
    await hubStore.deleteRun(row.runId); // placeholder dashboard goes with it
  }
  return row;
}
