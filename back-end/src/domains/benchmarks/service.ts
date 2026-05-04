// eslint-disable-next-line no-restricted-imports -- reads static benchmark JSON at startup
import fs from 'fs';
import { TASKS_PATH } from './config';
import { createLogger } from '../../providers/logger';

const log = createLogger('Benchmarks');

// Read once at startup — task definitions are static
let cachedTasks: unknown[] | null = null;
try {
  const parsed: unknown = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf-8'));
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
