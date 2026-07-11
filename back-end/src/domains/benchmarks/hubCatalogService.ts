/**
 * Benchmark Hub catalog: SQL-backed task definitions (seeded from tasks.json,
 * DB wins after seeding), per-task attempt stats, and validated metadata edits.
 */

import { z } from 'zod';
import { createLogger } from '../../providers/logger';
import { readTaskAttempts } from './config';
import * as hubStore from '../../providers/benchmarkHubStore';
import * as repo from './repo';
import { getCachedTasks, setCachedTasks } from './catalogCache';

const log = createLogger('BenchmarkHub');

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
    tags: Array.isArray(task.tags)
      ? (task.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
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
  const tasks = (getCachedTasks() ?? []) as RawTask[];
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
    setCachedTasks(rows.map((r) => r.definition as Record<string, unknown>));
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
  const [allRows, stats] = await Promise.all([repo.findAllTasks(), computeTaskStats()]);
  // Retired tasks exist only for history integrity — invisible in the hub.
  const rows = allRows.filter((row) => row.status !== 'retired');
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
    status: z.enum(['ready', 'incomplete', 'retired']).nullable().optional(),
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
  if (edit.description !== undefined) {
    // The catalog contract forbids empty descriptions — clearing removes the key.
    if (edit.description === '') delete definition.description;
    else definition.description = edit.description;
  }
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
