import { createLogger } from '../../providers/logger';
import { getCachedTasks } from './catalogCache';

const log = createLogger('Benchmarks');
void log; // logger retained for future route-level diagnostics

export class TasksUnavailableError extends Error {
  constructor() {
    super('Benchmark tasks unavailable');
  }
}

/**
 * Returns all visible benchmark task definitions. Retired tasks exist only
 * for history-ledger integrity — hidden from every serving surface. (The
 * poller's tasks.json export keeps file entries absent from this list
 * untouched, so retired file entries survive round-trips.)
 * Throws TasksUnavailableError if tasks.json failed to load at startup.
 */
export function getTasks(): unknown[] {
  const cached = getCachedTasks();
  if (!cached) {
    throw new TasksUnavailableError();
  }
  return cached.filter((task) => (task as { status?: unknown }).status !== 'retired');
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

export * from './hubCatalogService';
export * from './hubDispatchService';
