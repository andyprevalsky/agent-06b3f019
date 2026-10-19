/**
 * Task-path reads and the sibling-uniqueness guard.
 *
 * 10k-agent behavior: every query is keyed by the (busId, taskPath) index or
 * the primary key and touches at most a handful of rows; the uniqueness guard
 * takes one transaction-scoped advisory lock per new path, so concurrent
 * spawns contend only when they pick the same path in the same tree.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { TaskPathConflictError } from './agentTaskPath';

export interface TaskPathClaim {
  agentId: string;
  busId: string | null;
  taskPath?: string | null;
}

/** Inside the create transaction: serialize same-path creates and reject a live sibling. */
export async function assertTaskPathsFree(
  tx: Prisma.TransactionClient,
  claims: TaskPathClaim[]
): Promise<void> {
  const seen = new Set<string>();
  for (const claim of claims) {
    if (claim.taskPath === undefined || claim.taskPath === null || claim.busId === null) continue;
    const key = `${claim.busId}:${claim.taskPath}`;
    if (seen.has(key)) throw new TaskPathConflictError(claim.taskPath);
    seen.add(key);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const taken = await tx.agent.findFirst({
      where: {
        busId: claim.busId,
        taskPath: claim.taskPath,
        deletedAt: null,
        id: { not: claim.agentId },
      },
      select: { id: true },
    });
    if (taken !== null) throw new TaskPathConflictError(claim.taskPath);
  }
}

/** The parent's path inputs for computing a child path. */
export async function findPathParent(parentAgentId: string) {
  return prisma.agent.findUnique({
    where: { id: parentAgentId },
    select: { id: true, taskPath: true, parentAgentId: true },
  });
}

/**
 * Live agents in one tree holding any of `paths`, plus the root row when
 * `includeRoot` (a legacy root has a null path). One (busId, taskPath) read.
 */
export async function findAgentsByTreePaths(
  rootAgentId: string,
  userId: string,
  paths: string[],
  includeRoot: boolean
) {
  return prisma.agent.findMany({
    where: {
      busId: rootAgentId,
      userId,
      deletedAt: null,
      OR: [{ taskPath: { in: paths } }, ...(includeRoot ? [{ id: rootAgentId }] : [])],
    },
    select: {
      id: true,
      taskPath: true,
      parentAgentId: true,
      status: true,
      backgroundTasks: true,
    },
    take: paths.length + 1,
  });
}
