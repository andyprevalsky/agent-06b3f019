/**
 * Which workflow types the workers polling an agent task queue register.
 *
 *   worker start ─▶ PUT /api/agent-queue-pointer/capabilities {task_queue,
 *     workflow_types} ─▶ recordWorkerQueueCapabilities (idempotent upsert by queue)
 *   backend about to start a workflow type that only newer workers register (the
 *     code/browser resume runs) ─▶ queueServesWorkflowTypes(queue, types)
 *
 * A deploy whose Fly lane is held keeps the pointer on the old generation, whose
 * workers predate those types (and never recorded anything): the backend then
 * refuses the start with a truthful "workers are updating" instead of stranding a
 * run no worker will ever pick up. One indexed read per start; no polling.
 */
import { getEphemeral, putEphemeral } from './sharedState';
import { shouldUseBlackboxTemporalFake } from './temporalBlackboxFake';

const NAMESPACE = 'worker-queue-capabilities';
// A queue lives for one worker generation; every worker start renews it.
const TTL_MS = 180 * 24 * 60 * 60_000;
const SAFE_QUEUE = /^[A-Za-z0-9._@:-]{1,200}$/;
const SAFE_TYPE = /^[A-Za-z0-9_]{1,100}$/;

interface QueueCapabilities {
  workflowTypes: string[];
  recordedAt: string;
}

/** Record (merge) the workflow types a queue's workers register. */
export async function recordWorkerQueueCapabilities(
  taskQueue: string,
  workflowTypes: string[]
): Promise<void> {
  if (!SAFE_QUEUE.test(taskQueue)) throw new Error(`Unsafe task queue name: ${taskQueue}`);
  const types = workflowTypes.filter((type) => SAFE_TYPE.test(type));
  const previous = await getEphemeral<QueueCapabilities>(NAMESPACE, taskQueue);
  // Union: every worker of one generation registers the same set; a mixed rollout
  // never shrinks what an already-recorded worker serves.
  const merged = [...new Set([...(previous?.workflowTypes ?? []), ...types])].sort();
  await putEphemeral(
    NAMESPACE,
    taskQueue,
    { workflowTypes: merged, recordedAt: new Date().toISOString() },
    TTL_MS
  );
}

/**
 * Whether the queue's workers register every one of `workflowTypes`. A queue with
 * no record (workers that predate the registry) serves none of them. The local
 * in-memory blackbox Temporal client has no workers to record anything: an
 * unrecorded queue counts as serving there (a recorded one is still honored).
 */
export async function queueServesWorkflowTypes(
  taskQueue: string,
  workflowTypes: string[]
): Promise<boolean> {
  const record = await getEphemeral<QueueCapabilities>(NAMESPACE, taskQueue);
  if (record === undefined) return shouldUseBlackboxTemporalFake();
  return workflowTypes.every((type) => record.workflowTypes.includes(type));
}
