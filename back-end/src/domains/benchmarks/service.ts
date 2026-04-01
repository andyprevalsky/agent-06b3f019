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
    const valid = parsed.every(
      (t: unknown) =>
        typeof t === 'object' &&
        t !== null &&
        'id' in t &&
        'goal' in t &&
        typeof (t as Record<string, unknown>).id === 'string'
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
