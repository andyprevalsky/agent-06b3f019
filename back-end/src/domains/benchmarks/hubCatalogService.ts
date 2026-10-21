/**
 * Benchmark Hub catalog: task definitions from tasks.json (git source of truth),
 * per-task attempt stats, and read-only hub surface (no metadata edits).
 */

import { z } from 'zod';
import { readTaskAttempts, tasksFileUpdatedAtIso } from './config';
import { readCatalogTasks } from './catalog';
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
  /** True iff history has ≥5 attempts and the most recent 5 all passed. */
  last_five_passed: boolean;
}

/** How many consecutive recent passes qualify a task for the query-box green check. */
export const LAST_FIVE_PASS_WINDOW = 5;

/**
 * Pure helper: given attempts ordered oldest→newest, return whether the most
 * recent LAST_FIVE_PASS_WINDOW all passed. Fewer than WINDOW attempts → false.
 */
export function lastFiveAttemptsPassed(passedFlagsOldestFirst: boolean[]): boolean {
  if (passedFlagsOldestFirst.length < LAST_FIVE_PASS_WINDOW) return false;
  const recent = passedFlagsOldestFirst.slice(-LAST_FIVE_PASS_WINDOW);
  return recent.every((passed) => passed);
}

export interface AttemptSample {
  passed: boolean;
  status: string;
  duration: number | null;
  fastMode: boolean;
  timestamp: string;
  agentId: string | null;
}

/**
 * Merge the committed attempts ledger with hub uploads. The same agent_id
 * (ledger dual-write after a local bench) must count once, or a single pass
 * plus four older hub passes can fake a 5-pass green check.
 */
export function mergeAttemptSamples(
  ledger: AttemptSample[],
  hub: AttemptSample[]
): AttemptSample[] {
  const seen = new Set<string>();
  const merged: AttemptSample[] = [];
  const pushUnique = (sample: AttemptSample): void => {
    const key =
      sample.agentId !== null
        ? `id:${sample.agentId}`
        : `ts:${sample.timestamp}:${sample.passed}:${sample.duration ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(sample);
  };
  for (const sample of ledger) pushUnique(sample);
  for (const sample of hub) pushUnique(sample);
  merged.sort((a, b) => compareAttemptTimestamps(a.timestamp, b.timestamp));
  return merged;
}

/**
 * Chronological comparator for attempt timestamps (ISO strings).
 * Equal timestamps return 0 so Array.sort stays stable / deterministic.
 */
export function compareAttemptTimestamps(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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
  const ledgerByTask = new Map<string, AttemptSample[]>();
  const hubByTask = new Map<string, AttemptSample[]>();
  const push = (into: Map<string, AttemptSample[]>, task: string, sample: AttemptSample) => {
    const list = into.get(task) ?? [];
    list.push(sample);
    into.set(task, list);
  };
  for (const a of readTaskAttempts()) {
    push(ledgerByTask, a.task, {
      passed: a.passed,
      status: a.status,
      duration: a.duration_seconds,
      fastMode: a.fast_mode_cache,
      timestamp: a.timestamp,
      agentId: a.agent_id,
    });
  }
  for (const run of await hubStore.listRuns()) {
    if (run.live) continue; // only completed runs count toward stats
    for (const t of run.tasks) {
      push(hubByTask, t.name, {
        passed: t.passed === true,
        status: t.status,
        duration: t.duration_seconds,
        fastMode: t.fast_mode,
        timestamp: run.timestamp,
        agentId: t.agent_id,
      });
    }
  }
  const tasks = new Set<string>([...ledgerByTask.keys(), ...hubByTask.keys()]);
  const stats = new Map<string, TaskStats>();
  for (const task of tasks) {
    const list = mergeAttemptSamples(ledgerByTask.get(task) ?? [], hubByTask.get(task) ?? []);
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
      last_five_passed: lastFiveAttemptsPassed(list.map((s) => s.passed)),
    });
  }
  return stats;
}

const READY_STATUSES = new Set(['ready']);

/** Canonical catalog-group tokens the Benchmarks page filters + renders on. */
const CATALOG_GROUPS = [
  'pre-deploy',
  'daily',
  'rose-bench',
  'process-bench',
  'polar-bench',
  'incomplete',
] as const;

/**
 * Normalize a stored `group` label (from tasks.json) to a canonical token.
 * Tolerates casing + the human-readable aliases used historically
 * ("Daily", "Pre-Deploy", "Rose Bench", "Polar Bench", "Incomplete"). Returns null for an
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
 *   polar-bench — Odysseys + BU Bench V1 external capability suite
 *   rose-bench — harness-independent capability benches (bench field)
 *   daily      — every other ready pipeline-e2e task (the broad eval suite)
 */
function deriveTaskGroup(status: string | null, bench: string | null, tags: string[]): string {
  if (status !== null && !READY_STATUSES.has(status)) return 'incomplete';
  if (tags.includes('smoke')) return 'pre-deploy';
  if (tags.includes('process')) return 'process-bench';
  if (tags.includes('polar-bench')) return 'polar-bench';
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
