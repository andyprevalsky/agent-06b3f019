import fs from 'fs';
import path from 'path';

/** Server-only signing key for time-limited benchmark recording links. */
export function benchmarkShareSecret(): string | undefined {
  return process.env.BENCHMARK_SHARE_SECRET;
}

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

/**
 * ISO timestamp of the latest catalog file modification (for hub metadata).
 * Considers both tasks.json and polar_tasks.json so a polar-only edit still
 * bumps `updated_at`.
 */
export function tasksFileUpdatedAtIso(): string {
  let latestMs = 0;
  for (const catalogPath of [TASKS_PATH, POLAR_TASKS_PATH]) {
    try {
      latestMs = Math.max(latestMs, fs.statSync(catalogPath).mtimeMs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw err;
    }
  }
  return new Date(latestMs).toISOString();
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

let attemptsCache: { key: string; attempts: TaskAttempt[] } | null = null;

/**
 * The attempts ledger is its base file plus per-writer shards
 * `task_attempts.<YYYYMMDD>.<branch>.jsonl` in the same directory
 * (agents/benchmarks/history_ledger.py): each branch appends only to its own
 * shard, so concurrent PRs never edit one shared file. Shards sort by name.
 */
export function taskAttemptsLedgerFiles(basePath: string = TASK_ATTEMPTS_PATH): string[] {
  const dir = path.dirname(basePath);
  const stem = path.basename(basePath).replace(/\.jsonl$/, '');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [basePath];
  }
  const shards = names
    .filter(
      (name) => name.startsWith(`${stem}.`) && name.endsWith('.jsonl') && name !== `${stem}.jsonl`
    )
    .sort()
    .map((name) => path.join(dir, name));
  return [basePath, ...shards];
}

function parseAttempt(line: string): TaskAttempt | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.task !== 'string' || parsed.task === '') return null;
    return {
      task: parsed.task,
      passed: parsed.passed === true,
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      duration_seconds:
        typeof parsed.duration_seconds === 'number' ? parsed.duration_seconds : null,
      fast_mode_cache: parsed.fast_mode_cache === true,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
      agent_id:
        typeof parsed.agent_id === 'string' && parsed.agent_id !== '' ? parsed.agent_id : null,
    };
  } catch {
    return null; // skip malformed line
  }
}

function attemptTime(attempt: TaskAttempt): number {
  const value = Date.parse(attempt.timestamp);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/**
 * Parses the attempts ledger (one JSON object per line) and its shards, cached
 * by every file's mtime. Base rows keep file order; shard rows follow in
 * recorded (timestamp) order, then shard name and line, matching the Python
 * readers. Malformed lines are skipped — the ledger is append-only; a torn
 * write must not take the catalog stats down.
 */
export function readTaskAttempts(basePath: string = TASK_ATTEMPTS_PATH): TaskAttempt[] {
  const files: { file: string; mtimeMs: number }[] = [];
  for (const file of taskAttemptsLedgerFiles(basePath)) {
    try {
      files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // absent base file (lean worktree) or a shard removed mid-read
    }
  }
  if (files.length === 0) return [];
  const key = files.map(({ file, mtimeMs }) => `${file}:${mtimeMs}`).join('\n');
  if (attemptsCache && attemptsCache.key === key) {
    return attemptsCache.attempts;
  }
  const attempts: TaskAttempt[] = [];
  const shardRows: { attempt: TaskAttempt; time: number; fileIndex: number; lineIndex: number }[] =
    [];
  files.forEach(({ file }, fileIndex) => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return;
    }
    const isBase = file === basePath;
    raw.split('\n').forEach((line, lineIndex) => {
      const attempt = parseAttempt(line);
      if (!attempt) return;
      if (isBase) attempts.push(attempt);
      else shardRows.push({ attempt, time: attemptTime(attempt), fileIndex, lineIndex });
    });
  });
  shardRows.sort(
    (a, b) => a.time - b.time || a.fileIndex - b.fileIndex || a.lineIndex - b.lineIndex
  );
  for (const row of shardRows) attempts.push(row.attempt);
  attemptsCache = { key, attempts };
  return attempts;
}
