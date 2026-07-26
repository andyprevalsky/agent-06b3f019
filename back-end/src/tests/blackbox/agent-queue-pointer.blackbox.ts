#!/usr/bin/env tsx
/**
 * Black-box contract for the zero-downtime cutover routing pointer
 * (providers/agentQueuePointer.ts). Proves every behavior the deploy cutover
 * relies on:
 *   1. Absent pointer  -> falls back to TEMPORAL_TASK_QUEUE (backward-compatible).
 *   2. Set pointer     -> new workflows route to the generation queue.
 *   3. surfaceHash is persisted with the flip.
 *   4. Reads are cached (bounded cross-instance convergence, O(1) at 10k agents)
 *      and refresh after the TTL.
 *   5. A flip invalidates the local cache immediately (no TTL lag on the flipper).
 *   6. Neither pointer nor env -> throws (never silently routes nowhere).
 */
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  AGENT_QUEUE_POINTER_CACHE_TTL_MS,
  __resetAgentQueuePointerCacheForTest,
  getCurrentAgentQueue,
  readAgentQueuePointer,
  setCurrentAgentQueue,
} from '../../providers/agentQueuePointer';

config();

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function clearPointer(): Promise<void> {
  await prisma.agentQueuePointer.deleteMany({});
  __resetAgentQueuePointerCacheForTest();
}

async function main(): Promise<void> {
  const originalEnvQueue = process.env.TEMPORAL_TASK_QUEUE;
  try {
    // 1. Absent pointer -> env fallback.
    await clearPointer();
    process.env.TEMPORAL_TASK_QUEUE = 'navi-agent-tasks';
    assert(
      (await getCurrentAgentQueue()) === 'navi-agent-tasks',
      'absent pointer must fall back to TEMPORAL_TASK_QUEUE'
    );

    // 2. Set pointer -> generation queue wins over env.
    await clearPointer();
    await setCurrentAgentQueue('navi-agent-tasks@abc123', 'abc123', 'test');
    assert(
      (await getCurrentAgentQueue()) === 'navi-agent-tasks@abc123',
      'set pointer must route new workflows to the generation queue'
    );

    // 3. surfaceHash persisted with the flip.
    const row = await readAgentQueuePointer();
    assert(row?.surfaceHash === 'abc123', 'flip must persist the surface hash');
    assert(row?.taskQueue === 'navi-agent-tasks@abc123', 'flip must persist the queue');

    // 4. Caching + TTL refresh (deterministic via injected clock).
    await clearPointer();
    await setCurrentAgentQueue('navi-agent-tasks@gen1', 'gen1', 'test');
    __resetAgentQueuePointerCacheForTest();
    const t0 = 1_000_000;
    assert(
      (await getCurrentAgentQueue(t0)) === 'navi-agent-tasks@gen1',
      'first read populates the cache with the current generation'
    );
    // Mutate the row WITHOUT going through setCurrentAgentQueue, so the cache is
    // not cleared — a stale read within the TTL must still serve the old value.
    await prisma.agentQueuePointer.update({
      where: { id: 'singleton' },
      data: { taskQueue: 'navi-agent-tasks@gen2', surfaceHash: 'gen2' },
    });
    assert(
      (await getCurrentAgentQueue(t0 + AGENT_QUEUE_POINTER_CACHE_TTL_MS - 1)) ===
        'navi-agent-tasks@gen1',
      'within TTL the cached generation is served (no per-start DB hit)'
    );
    assert(
      (await getCurrentAgentQueue(t0 + AGENT_QUEUE_POINTER_CACHE_TTL_MS + 1)) ===
        'navi-agent-tasks@gen2',
      'after TTL the pointer is re-read and the new generation is served'
    );

    // 5. A flip invalidates the local cache immediately.
    __resetAgentQueuePointerCacheForTest();
    assert(
      (await getCurrentAgentQueue()) === 'navi-agent-tasks@gen2',
      'precondition: cache holds gen2'
    );
    await setCurrentAgentQueue('navi-agent-tasks@gen3', 'gen3', 'test');
    assert(
      (await getCurrentAgentQueue()) === 'navi-agent-tasks@gen3',
      'flip must invalidate the local cache so the flipper routes to the new queue immediately'
    );

    // 6. Neither pointer nor env -> throw (never route nowhere).
    await clearPointer();
    delete process.env.TEMPORAL_TASK_QUEUE;
    let threw = false;
    try {
      await getCurrentAgentQueue();
    } catch {
      threw = true;
    }
    assert(threw, 'with no pointer and no env, resolution must throw, not route nowhere');

    process.stdout.write(
      'PASS agent-queue-pointer: fallback, flip, cache/TTL, invalidation, fail-loud\n'
    );
  } finally {
    await prisma.agentQueuePointer.deleteMany({}).catch(() => {});
    __resetAgentQueuePointerCacheForTest();
    if (originalEnvQueue === undefined) {
      delete process.env.TEMPORAL_TASK_QUEUE;
    } else {
      process.env.TEMPORAL_TASK_QUEUE = originalEnvQueue;
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
