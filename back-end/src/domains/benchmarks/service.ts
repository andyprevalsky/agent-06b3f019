import { benchmarkAgentPreviewEnabled as benchmarkAgentPreviewEnabledFromConfig } from './config';
import { readCatalogTasks } from './catalog';
import { createLogger } from '../../providers/logger';
import { getAgentDetailForPreview } from '../../providers/agentDetailQuery';
import { getClaudeCodeSession } from '../../providers/e2b';
import { computeTaskStats } from './hubCatalogService';

const log = createLogger('Benchmarks');
void log; // logger retained for future route-level diagnostics

export { TasksUnavailableError } from './types';

/**
 * Returns all visible benchmark task definitions. Retired tasks exist only
 * for history-ledger integrity — hidden from every serving surface. (The
 * poller's tasks.json export keeps file entries absent from this list
 * untouched, so retired file entries survive round-trips.)
 * Throws TasksUnavailableError if tasks.json is missing or malformed.
 */
export function getTasks(): unknown[] {
  return readCatalogTasks().filter((task) => (task as { status?: unknown }).status !== 'retired');
}

export interface TestPrompt {
  title: string;
  description: string;
  prompt: string;
  attachmentUrls: string[];
  tags: string[];
  /**
   * True when run history has ≥5 attempts for this task and the most recent
   * 5 all passed — drives the green check in the query-box prompt list.
   */
  lastFivePassed: boolean;
}

interface CatalogTaskShape {
  name?: unknown;
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
 * - Only agent-runner entries are included. Other runners (e.g. `sms`, which
 *   drives the SMS supervisor through a scripted inbound thread) carry a
 *   scenario description in `prompt`, not an agent goal, so they would be
 *   meaningless in the query box.
 * - `{frontend_url}` (run_benchmark's token) is rewritten to the front-end's
 *   `{{TEST_PAYMENT_BASE_URL}}` token, which TestPromptsSelector resolves to
 *   the live tunnel URL.
 * - Bare attachment names become `/test-assets/*` public paths.
 * - Catalog `tags` pass through so the picker can filter prompts by tag.
 * - `lastFivePassed` joins per-task run history (committed ledger + hub
 *   completed runs) so the picker can show a green check for stable tasks.
 *
 * Diagram:
 *   task_attempts.jsonl + hub runs → computeTaskStats.last_five_passed
 *        → GET /test-prompts.lastFivePassed → PromptList green check
 */
export async function getTestPrompts(): Promise<TestPrompt[]> {
  const stats = await computeTaskStats();
  return (getTasks() as CatalogTaskShape[])
    .filter((task) => (task.runner ?? 'agent') === 'agent')
    .map((task) => {
      // The catalog may also list several files under `attachment`.
      const attachments = Array.isArray(task.attachments)
        ? (task.attachments as string[])
        : Array.isArray(task.attachment)
          ? (task.attachment as string[])
          : typeof task.attachment === 'string'
            ? [task.attachment]
            : [];
      const title = typeof task.title === 'string' ? task.title : '';
      const name = typeof task.name === 'string' ? task.name : '';
      return {
        title,
        description: typeof task.description === 'string' ? task.description : title,
        prompt: task.prompt.replaceAll('{frontend_url}', '{{TEST_PAYMENT_BASE_URL}}'),
        attachmentUrls: attachments.map((name) => `/test-assets/${name}`),
        tags: Array.isArray(task.tags)
          ? (task.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
          : [],
        lastFivePassed: stats.get(name)?.last_five_passed === true,
      };
    });
}

export function benchmarkAgentPreviewEnabled(): boolean {
  return benchmarkAgentPreviewEnabledFromConfig();
}

export async function getBenchmarkAgentPreview(agentId: string) {
  if (!benchmarkAgentPreviewEnabled()) {
    return null;
  }
  return getAgentDetailForPreview(agentId);
}

/** Benchmark-only unauthenticated read for durable Claude Code session output. */
export async function getBenchmarkClaudeCodeSessionPreview(taskId: string) {
  if (!benchmarkAgentPreviewEnabled()) {
    return null;
  }
  const session = await getClaudeCodeSession(taskId);
  if (session === undefined || session === null) {
    return null;
  }
  return {
    task_id: session.id,
    sandbox_id: session.sandboxId,
    stream_url: session.streamUrl,
    goal: session.goal,
    status: session.status,
    output: session.output,
    created_at: session.createdAt,
    closed_at: session.closedAt,
  };
}

export * from './hubCatalogService';
export * from './hubDispatchService';
