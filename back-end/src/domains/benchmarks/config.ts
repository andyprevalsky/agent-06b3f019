import fs from 'fs';
import path from 'path';

/** Absolute path to the benchmark task definitions JSON file. */
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

/**
 * Reads and parses the benchmark task catalog from disk.
 * File system access lives here per the no-restricted-imports rule
 * (fs is restricted to config.ts / providers).
 */
export function readTasksFile(): unknown {
  return JSON.parse(fs.readFileSync(TASKS_PATH, 'utf-8'));
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
      });
    } catch {
      // skip malformed line
    }
  }
  attemptsCache = { mtimeMs: stat.mtimeMs, attempts };
  return attempts;
}
