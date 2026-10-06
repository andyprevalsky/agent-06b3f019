import assert from 'node:assert';
import { prisma } from '../../providers/database';

export const ARCHIVE_BENCHMARK_TASK = 'archive-blackbox';

const seededRootAgentIds: string[] = [];

export function trackSeededRootAgent(rootAgentId: string): void {
  seededRootAgentIds.push(rootAgentId);
}

/**
 * Benchmark-tagged history rows are shared search corpus for every user, so rows orphaned by an
 * interrupted run crowd other domains' fixtures out of the planner-memory result limit.
 */
export async function purgeOrphanedArchiveMemories(): Promise<void> {
  const rows = await prisma.plannerMemory.findMany({
    where: { benchmarkTaskName: ARCHIVE_BENCHMARK_TASK },
    select: { id: true },
  });
  const rowIds = rows.map((row) => row.id);
  const live = new Set(
    (await prisma.agent.findMany({ where: { id: { in: rowIds } }, select: { id: true } })).map(
      (agent) => agent.id
    )
  );
  await prisma.plannerMemory.deleteMany({
    where: { id: { in: rowIds.filter((id) => !live.has(id)) } },
  });
}

export async function testCleanupLeavesNoPlannerMemoryRows(): Promise<void> {
  const leaked = await prisma.plannerMemory.count({ where: { id: { in: seededRootAgentIds } } });
  assert.strictEqual(leaked, 0, `archive cleanup left ${leaked} planner-memory history row(s)`);
}
