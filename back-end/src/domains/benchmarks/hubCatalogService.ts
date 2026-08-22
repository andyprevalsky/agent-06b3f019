/**
 * Benchmark Hub catalog: task definitions from tasks.json (git source of truth),
 * per-task attempt stats, and read-only hub surface (no metadata edits).
 */

import { z } from 'zod';
import { readTaskAttempts, readCatalogTasks, tasksFileUpdatedAtIso } from './config';
import * as hubStore from '../../providers/benchmarkHubStore';

export { seedBenchmarkTasks, ensureBenchmarkTasksSeeded } from './hubCatalogSeed';

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

/** Canonical catalog-group tokens the Benchmarks page filters + renders on. */
const CATALOG_GROUPS = ['pre-deploy', 'daily', 'rose-bench', 'incomplete'] as const;

/**
 * Normalize a stored `group` label (from tasks.json) to a canonical token.
 * Tolerates casing + the human-readable aliases used historically
 * ("Daily", "Pre-Deploy", "Rose Bench", "Incomplete"). Returns null for an
 * absent or unrecognized label so the caller falls back to derivation.
 */
function normalizeStoredGroup(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return (CATALOG_GROUPS as readonly string[]).includes(token) ? token : null;
}

/**
 * Derive the catalog group when a task carries no explicit `group` label
 * (matches how the suites actually run):
 *   incomplete — not runnable (missing fixtures/judges; excluded from suites)
 *   pre-deploy — the `smoke` tag set (`run_benchmark.py --suite smoke`, the
 *                gate /deploy and scripts/test.sh run before merging)
 *   rose-bench — harness-independent capability benches (bench field)
 *   daily      — every other ready pipeline-e2e task (the broad eval suite)
 */
function deriveTaskGroup(status: string | null, bench: string | null, tags: string[]): string {
  if (status !== null && !READY_STATUSES.has(status)) return 'incomplete';
  if (tags.includes('smoke')) return 'pre-deploy';
  if (bench === 'rose-bench') return 'rose-bench';
  return 'daily';
}

/**
 * The Benchmarks page groups off the stored `group` label (tasks.json →
 * definition.group). Derivation is only the fallback for tasks that carry no
 * explicit label.
 */
function resolveTaskGroup(
  storedGroup: unknown,
  status: string | null,
  bench: string | null,
  tags: string[]
): string {
  return normalizeStoredGroup(storedGroup) ?? deriveTaskGroup(status, bench, tags);
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

function toCatalogTask(task: Record<string, unknown>, stats: Map<string, TaskStats>): CatalogTask {
  const name = task.name as string;
  const env = (task.environment ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(task.tags)
    ? (task.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  const status = typeof task.status === 'string' ? task.status : null;
  const bench = typeof task.bench === 'string' ? task.bench : null;
  const worldModelMode =
    typeof env.mode === 'string'
      ? env.mode
      : typeof task.world_model_mode === 'string'
        ? task.world_model_mode
        : null;
  return {
    name,
    title: typeof task.title === 'string' ? task.title : null,
    description:
      typeof task.description === 'string' && task.description !== '' ? task.description : null,
    prompt: task.prompt as string,
    status,
    bench,
    group: resolveTaskGroup(task.group, status, bench, tags),
    tags,
    timeout_seconds: typeof task.timeout_seconds === 'number' ? task.timeout_seconds : null,
    price_limit_cents: typeof task.price_limit_cents === 'number' ? task.price_limit_cents : null,
    expected_tools: Array.isArray(task.expected_tools)
      ? (task.expected_tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    min_agent_count: typeof task.min_agent_count === 'number' ? task.min_agent_count : null,
    is_chat_mode: task.is_chat_mode === true,
    world_model_mode: worldModelMode,
    updated_at: tasksFileUpdatedAtIso(),
    updated_by: null,
    stats: stats.get(name) ?? null,
  };
}

/** Visible benchmark tasks from tasks.json (retired entries excluded). */
function getVisibleFileTasks(): Record<string, unknown>[] {
  return readCatalogTasks()
    .filter((task) => (task as { status?: unknown }).status !== 'retired')
    .map((task) => task as Record<string, unknown>);
}

/** The hub catalog: every task from tasks.json, joined with attempt stats. */
export async function getCatalog(): Promise<CatalogTask[]> {
  const [tasks, stats] = await Promise.all([
    Promise.resolve(getVisibleFileTasks()),
    computeTaskStats(),
  ]);
  return tasks.map((task) => toCatalogTask(task, stats));
}

/** Retained for route validation tests; hub task edits are disabled. */
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

export class TaskEditsDisabledError extends Error {
  constructor() {
    super('Benchmark task definitions are read-only; edit agents/benchmarks/tasks.json');
  }
}
