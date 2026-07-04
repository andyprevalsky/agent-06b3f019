import { readTasksFile } from './config';
import { createLogger } from '../../providers/logger';

const log = createLogger('Benchmarks');

// Read once at startup — task definitions are static
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

export interface TestPrompt {
  title: string;
  description: string;
  prompt: string;
  attachmentUrls: string[];
  tags: string[];
}

interface CatalogTaskShape {
  title?: unknown;
  description?: unknown;
  prompt: string;
  attachment?: unknown;
  attachments?: unknown;
  runner?: unknown;
  tags?: unknown;
}

/**
 * Adapts the benchmark catalog into the shape the front-end test-prompts
 * picker consumes. This is the single source the query box reads from, so the
 * picker can never drift from the eval catalog.
 *
 * - Only agent-runner entries are included (external vitest smokes are not
 *   agent goals).
 * - `{frontend_url}` (run_benchmark's token) is rewritten to the front-end's
 *   `{{TEST_PAYMENT_BASE_URL}}` token, which TestPromptsSelector resolves to
 *   the live tunnel URL.
 * - Bare attachment names become `/test-assets/*` public paths.
 * - Catalog `tags` pass through so the picker can filter prompts by tag.
 */
export function getTestPrompts(): TestPrompt[] {
  return (getTasks() as CatalogTaskShape[])
    .filter((task) => (task.runner ?? 'agent') === 'agent')
    .map((task) => {
      const attachments = Array.isArray(task.attachments)
        ? (task.attachments as string[])
        : typeof task.attachment === 'string'
          ? [task.attachment]
          : [];
      const title = typeof task.title === 'string' ? task.title : '';
      return {
        title,
        description: typeof task.description === 'string' ? task.description : title,
        prompt: task.prompt.replaceAll('{frontend_url}', '{{TEST_PAYMENT_BASE_URL}}'),
        attachmentUrls: attachments.map((name) => `/test-assets/${name}`),
        tags: Array.isArray(task.tags)
          ? (task.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
          : [],
      };
    });
}
