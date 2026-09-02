import fs from 'fs';
import path from 'path';

/** Absolute path to the first-party benchmark task definitions JSON file. */
export const TASKS_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'agents',
  'benchmarks',
  'tasks.json'
);

/** Polar Odysseys + BU Bench V1 catalog slice (group/tag = polar-bench). */
export const POLAR_TASKS_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'agents',
  'benchmarks',
  'polar_tasks.json'
);

/**
 * Reads and parses the benchmark task catalog from disk.
 * File system access lives here per the no-restricted-imports rule
 * (fs is restricted to config.ts / providers).
 *
 * Merges tasks.json with polar_tasks.json so the hub / test-prompts picker
 * sees Odysseys + BU Bench V1 under group `polar-bench` (never `daily`).
 */
export function readTasksFile(): unknown {
  const primary = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf-8')) as unknown;
  if (!Array.isArray(primary)) {
    return primary;
  }
  let polar: unknown = [];
  try {
    polar = JSON.parse(fs.readFileSync(POLAR_TASKS_PATH, 'utf-8')) as unknown;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
    polar = [];
  }
  if (!Array.isArray(polar)) {
    throw new Error('polar_tasks.json must be a JSON array');
  }
  return [...primary, ...polar];
}

/** ISO timestamp of the last tasks.json modification (for hub catalog metadata). */
export function tasksFileUpdatedAtIso(): string {
  try {
    return fs.statSync(TASKS_PATH).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export function benchmarkAgentPreviewEnabled(): boolean {
  const enabledValues = new Set(['1', 'true', 'yes', 'on']);
  // Defense-in-depth: the preview is unauthenticated and RLS-free, so it must
  // NEVER be reachable on the canonical prod backend even if a benchmark flag
  // leaks into that environment. Render sets RENDER=true on its services, so we
  // hard-disable there regardless of the benchmark flags below. Isolated
  // benchmark stacks (local + Fly cloudbench boxes) don't set RENDER.
  if (enabledValues.has(String(process.env.RENDER ?? '').toLowerCase())) return false;
  return (
    enabledValues.has(String(process.env.BENCHMARK_MODE ?? '').toLowerCase()) ||
    enabledValues.has(String(process.env.BENCHMARK_ISOLATED_RUN ?? '').toLowerCase())
  );
}

/** Absolute path to the committed per-attempt history ledger. */
export const TASK_ATTEMPTS_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'agents',
  'benchmarks',
  'history',
  'task_attempts.jsonl'
);

export interface TaskAttempt {
  task: string;
  passed: boolean;
  status: string;
  duration_seconds: number | null;
  fast_mode_cache: boolean;
  timestamp: string;
  agent_id: string | null;
}

let attemptsCache: { mtimeMs: number; attempts: TaskAttempt[] } | null = null;

/**
 * Parses the attempts ledger (one JSON object per line), cached by mtime.
 * Malformed lines are skipped — the ledger is append-only; a torn write must
 * not take the catalog stats down.
 */
export function readTaskAttempts(): TaskAttempt[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(TASK_ATTEMPTS_PATH);
  } catch {
    return [];
  }
  if (attemptsCache && attemptsCache.mtimeMs === stat.mtimeMs) {
    return attemptsCache.attempts;
  }
  const attempts: TaskAttempt[] = [];
  const raw = fs.readFileSync(TASK_ATTEMPTS_PATH, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.task !== 'string' || parsed.task === '') continue;
      attempts.push({
        task: parsed.task,
        passed: parsed.passed === true,
        status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
        duration_seconds:
          typeof parsed.duration_seconds === 'number' ? parsed.duration_seconds : null,
        fast_mode_cache: parsed.fast_mode_cache === true,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
        agent_id:
          typeof parsed.agent_id === 'string' && parsed.agent_id !== '' ? parsed.agent_id : null,
      });
    } catch {
      // skip malformed line
    }
  }
  attemptsCache = { mtimeMs: stat.mtimeMs, attempts };
  return attempts;
}
