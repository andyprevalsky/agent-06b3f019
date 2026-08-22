/**
 * In-memory public catalog cache for benchmark tasks. Always reflects
 * agents/benchmarks/tasks.json — the git-checked-in source of truth.
 */

import { readTasksFile } from './config';
import { createLogger } from '../../providers/logger';

const log = createLogger('Benchmarks');

// tasks.json entries are keyed by `name` and `prompt` (mirrors
// benchmarks.blackbox.ts BenchmarkTaskSchema). The earlier `id`/`goal`
// validator never matched any entry, which silently turned the route into
// a permanent 500 — fix is to validate the actual shape.
function isValidTaskShape(t: unknown): boolean {
  return (
    typeof t === 'object' &&
    t !== null &&
    'name' in t &&
    'prompt' in t &&
    typeof (t as Record<string, unknown>).name === 'string' &&
    typeof (t as Record<string, unknown>).prompt === 'string'
  );
}

let cachedTasks: unknown[] | null = null;

function loadTasksFromFile(): unknown[] | null {
  try {
    const parsed = readTasksFile();
    if (!Array.isArray(parsed)) {
      log.error('Benchmark tasks file is not an array');
      return null;
    }
    if (!parsed.every(isValidTaskShape)) {
      log.error('Benchmark tasks file contains malformed entries');
      return null;
    }
    return parsed;
  } catch (err) {
    log.error('Failed to load benchmark tasks from file', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Prime the cache at import so routes can serve before the async seed finishes.
cachedTasks = loadTasksFromFile();

export function getCachedTasks(): unknown[] | null {
  return cachedTasks;
}

/** Reload the in-memory cache from tasks.json on disk. */
export function reloadTasksFromFile(): void {
  const tasks = loadTasksFromFile();
  if (tasks !== null) {
    cachedTasks = tasks;
  }
}

export function setCachedTasks(tasks: unknown[]): void {
  if (!tasks.every(isValidTaskShape)) {
    log.error('Refusing to cache malformed task definitions');
    return;
  }
  cachedTasks = tasks;
}
