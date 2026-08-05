/**
 * Pure task-queue classification for pre-deploy stale-workflow cleanup.
 *
 * Kept free of `@temporalio/client` so the "never touch prod" invariant can be
 * unit-tested without the Temporal SDK (and without a live connection).
 */
import { isIsolatedBenchmarkResource } from './benchmarkResources';

export const PROD_QUEUE = 'navi-agent-tasks';
export const QUEUE_PREFIX = 'navi-agent-tasks-';

/**
 * Decision for a single Running workflow's task queue during pre-deploy cleanup.
 * `skip-*` variants are protected (never terminated); `terminate` is stale/unknown.
 */
export type CleanupQueueDecision = 'skip-prod' | 'skip-benchmark' | 'skip-active' | 'terminate';

/**
 * Strip the Temporal Worker Versioning build-id suffix from a task queue name.
 *
 * `workflow.list()` reports the queue a workflow is running on as
 * `<queue>@<build-id>` (e.g. `navi-agent-tasks@ebdc7ba275e9`) when the worker
 * registered with a build id. Cleanup decisions must compare against the base
 * queue name, never the versioned string.
 */
export function baseTaskQueue(queue: string): string {
  return queue.split('@', 1)[0];
}

/**
 * Classify a workflow's task queue as protected or stale.
 *
 * MUST enforce the "never touch prod" invariant. Because prod/workspace workers
 * register under Worker Versioning, the queue carries a build-id suffix; every
 * comparison is made against the base queue name so a versioned prod, active, or
 * benchmark queue is still recognized and protected.
 */
export function classifyCleanupQueue(
  queue: string,
  activeNames: Set<string>
): CleanupQueueDecision {
  const base = baseTaskQueue(queue);

  // Never touch prod
  if (base === PROD_QUEUE) return 'skip-prod';

  // Isolated benchmarks own their queue and DB lifetime through benchmarks/local.py.
  // They are intentionally absent from Conductor's workspace registry.
  if (isIsolatedBenchmarkResource(base)) return 'skip-benchmark';

  // Check if queue belongs to an active workspace
  if (base.startsWith(QUEUE_PREFIX)) {
    const queueWorkspace = base.slice(QUEUE_PREFIX.length);
    if (activeNames.has(queueWorkspace)) return 'skip-active';
  }

  // Stale or unknown — terminate
  return 'terminate';
}
