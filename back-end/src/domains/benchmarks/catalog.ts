/**
 * Benchmark catalog reader — validates and returns tasks.json entries on every
 * call. Git file is the sole source of truth (no in-memory cache).
 */

import { readTasksFile } from './config';
import { createLogger } from '../../providers/logger';
import { TasksUnavailableError } from './types';

const log = createLogger('Benchmarks');

function isValidCatalogTaskShape(task: unknown): boolean {
  return (
    typeof task === 'object' &&
    task !== null &&
    'name' in task &&
    'prompt' in task &&
    typeof (task as Record<string, unknown>).name === 'string' &&
    typeof (task as Record<string, unknown>).prompt === 'string'
  );
}

export function readCatalogTasks(): unknown[] {
  let parsed: unknown;
  try {
    parsed = readTasksFile();
  } catch (err) {
    log.error('Failed to load benchmark tasks from file', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new TasksUnavailableError();
  }
  if (!Array.isArray(parsed)) {
    log.error('Benchmark tasks file is not an array');
    throw new TasksUnavailableError();
  }
  if (!parsed.every(isValidCatalogTaskShape)) {
    log.error('Benchmark tasks file contains malformed entries');
    throw new TasksUnavailableError();
  }
  return parsed;
}

/**
 * File names a catalog task attaches. `attachments` wins over `attachment`; either
 * may be one name or a list. Only non-empty string names count, so a malformed
 * member never becomes an asset URL such as `/test-assets/[object Object]`.
 */
export function catalogAttachmentNames(task: {
  attachment?: unknown;
  attachments?: unknown;
}): string[] {
  const listed: unknown[] = Array.isArray(task.attachments)
    ? (task.attachments as unknown[])
    : Array.isArray(task.attachment)
      ? (task.attachment as unknown[])
      : [task.attachment];
  return listed.filter((file): file is string => typeof file === 'string' && file.trim() !== '');
}
