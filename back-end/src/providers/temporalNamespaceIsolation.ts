/**
 * Keeps dev and benchmark backends out of the production Temporal namespace.
 *
 *   bootstrap -> assertTemporalNamespaceIsolation(env)
 *     prod namespace + prod queue (navi-agent-tasks[@gen] | worker pool) -> ok
 *     prod namespace + any other queue (navi-agent-tasks-<workspace>...)  -> throw
 *     any other namespace / blackbox fake                                  -> ok
 *
 * A dev or benchmark stack's per-stack queue loses its worker when the stack
 * stops, and its workflows stay Running forever. 4,094 of them sat in the
 * production namespace on 2026-10-27, sharing production's action and
 * Visibility API budgets. scripts/run.sh routes stacks to the benchmark
 * namespace; this guard fails a stack that bypasses it. Mirror of
 * agents/temporal_connection.py:production_namespace_refusal.
 */
export const PRODUCTION_TEMPORAL_NAMESPACE = 'rose-labs-us-east-1.tch2n';
const PRODUCTION_BASE_TASK_QUEUE = 'navi-agent-tasks';
const PRODUCTION_POOL_QUEUE = /^navi-agent-tasks-pool-[a-f0-9]{12}(@[A-Za-z0-9]+)?$/;

export function isProductionTaskQueue(taskQueue: string): boolean {
  const queue = taskQueue.trim();
  return queue.split('@', 1)[0] === PRODUCTION_BASE_TASK_QUEUE || PRODUCTION_POOL_QUEUE.test(queue);
}

export function assertTemporalNamespaceIsolation(env: NodeJS.ProcessEnv = process.env): void {
  if (env.BLACKBOX_TEST_FAKE_TEMPORAL === '1') return;
  const namespace = (env.TEMPORAL_NAMESPACE ?? '').trim();
  const queue = env.TEMPORAL_TASK_QUEUE ?? '';
  if (namespace !== PRODUCTION_TEMPORAL_NAMESPACE || isProductionTaskQueue(queue)) return;
  throw new Error(
    `Refusing Temporal queue "${queue}" in the production namespace ${PRODUCTION_TEMPORAL_NAMESPACE}: ` +
      'dev and benchmark stacks must use the benchmark namespace. Start the stack with ' +
      'scripts/run.sh (it routes to the namespace in agents/.env.benchmark-temporal), or export ' +
      'TEMPORAL_ADDRESS/TEMPORAL_NAMESPACE/TEMPORAL_API_KEY for a non-production namespace.'
  );
}
