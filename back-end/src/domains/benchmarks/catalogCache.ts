/**
 * In-memory public catalog cache shared by the legacy file-backed routes and
 * the SQL-backed hub: seeded from tasks.json at import, replaced with DB
 * definitions once the BenchmarkTask table is seeded/edited.
 */

import { readTasksFile } from './config';
import { createLogger } from '../../providers/logger';

const log = createLogger('Benchmarks');

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

export function getCachedTasks(): unknown[] | null {
  return cachedTasks;
}

export function setCachedTasks(tasks: unknown[]): void {
  cachedTasks = tasks;
}
