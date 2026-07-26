/**
 * Current-generation agent task-queue pointer for zero-downtime cutover.
 *
 * New agent workflows route to the queue named here (`navi-agent-tasks@<surfaceHash>`).
 * The deploy cutover flips this atomically once new-generation workers are live,
 * so new work lands on the new fleet the instant it flips — no standby window.
 *
 * Backward-compatible: when the singleton row is ABSENT, `getCurrentAgentQueue`
 * falls back to `process.env.TEMPORAL_TASK_QUEUE` (today's behavior), so this is
 * inert until a cutover writes it.
 *
 * 10k-agent safety: the value is cached in-process with a short TTL, so this is a
 * ~O(1) memory read per workflow start, not a per-start DB query. A flip clears
 * this instance's cache immediately; other instances converge within the TTL —
 * which is why the cutover keeps old-generation workers alive past the TTL before
 * scaling them down (any lagged routing is still served).
 */
import { prisma } from './database';

const SINGLETON_ID = 'singleton';

/** In-process cache TTL. Bounds cross-instance routing convergence after a flip. */
export const AGENT_QUEUE_POINTER_CACHE_TTL_MS = 5000;

interface QueueCache {
  queue: string;
  expiresAt: number;
}

let cache: QueueCache | null = null;

/** Test-only: clear the in-process cache so each case starts cold. */
export function __resetAgentQueuePointerCacheForTest(): void {
  cache = null;
}

/**
 * Resolve the task queue that a NEW agent workflow should start on.
 * Order: cached value → AgentQueuePointer row → TEMPORAL_TASK_QUEUE env.
 * Throws only if BOTH the row is absent AND the env is unset (never silently
 * routes nowhere). A genuine DB error propagates — we do not mask it.
 */
export async function getCurrentAgentQueue(now: number = Date.now()): Promise<string> {
  if (cache && cache.expiresAt > now) {
    return cache.queue;
  }
  const row = await prisma.agentQueuePointer.findUnique({
    where: { id: SINGLETON_ID },
  });
  const resolved = row?.taskQueue || process.env.TEMPORAL_TASK_QUEUE;
  if (!resolved) {
    throw new Error(
      'No agent task queue available: AgentQueuePointer is unset and TEMPORAL_TASK_QUEUE is not set'
    );
  }
  cache = { queue: resolved, expiresAt: now + AGENT_QUEUE_POINTER_CACHE_TTL_MS };
  return resolved;
}

/**
 * Atomically point new agent workflows at `taskQueue` (the new generation),
 * recording the surface hash that generation was built from. Called by the
 * deploy cutover after the new-generation workers are confirmed live. Clears the
 * local cache so this instance routes to the new queue immediately.
 */
export async function setCurrentAgentQueue(
  taskQueue: string,
  surfaceHash: string,
  updatedBy?: string
): Promise<void> {
  await prisma.agentQueuePointer.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, taskQueue, surfaceHash, updatedBy: updatedBy ?? null },
    update: { taskQueue, surfaceHash, updatedBy: updatedBy ?? null },
  });
  cache = null;
}

/** Read the raw pointer row (or null). For deploy tooling / diagnostics. */
export async function readAgentQueuePointer(): Promise<{
  taskQueue: string;
  surfaceHash: string;
  updatedBy: string | null;
  updatedAt: Date;
} | null> {
  const row = await prisma.agentQueuePointer.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return null;
  return {
    taskQueue: row.taskQueue,
    surfaceHash: row.surfaceHash,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}
