/**
 * Bounded reads behind GET /api/agents/:id/tree (navigable tree view).
 *
 * 10k-agent behavior: no query here reads the whole tree. Ancestor walks are
 * primary-key lookups (one batched query per level, depth is small); child
 * pages use the (parentAgentId, createdAt) index with a keyset cursor and a
 * LIMIT; child counts are one groupBy over DIRECT children of the listed page
 * (never full-subtree counts); search filters one tree by the busId index and
 * stops at LIMIT. Cost scales with the page shown, not with tree size.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export const TREE_GOAL_MAX_CHARS = 200;

const NODE_SELECT = {
  id: true,
  userId: true,
  busId: true,
  parentAgentId: true,
  depth: true,
  goal: true,
  status: true,
  createdAt: true,
  deletedAt: true,
  backgroundTasks: true,
  taskPath: true,
  toolsInUse: true,
} as const;

export type TreeNodeRow = Prisma.AgentGetPayload<{ select: typeof NODE_SELECT }>;

export interface ChildCursor {
  createdAt: Date;
  id: string;
}

/** Primary-key lookup of a handful of agents (ancestor walk, node resolution). */
export async function findTreeNodesByIds(ids: string[]): Promise<TreeNodeRow[]> {
  if (ids.length === 0) return [];
  return prisma.agent.findMany({ where: { id: { in: ids } }, select: NODE_SELECT });
}

/** One keyset page of `parentId`'s live direct children, oldest first; fetches limit+1. */
export async function findChildPage(
  parentId: string,
  userId: string,
  limit: number,
  after: ChildCursor | undefined
): Promise<TreeNodeRow[]> {
  return prisma.agent.findMany({
    where: {
      parentAgentId: parentId,
      userId,
      deletedAt: null,
      ...(after !== undefined
        ? {
            OR: [
              { createdAt: { gt: after.createdAt } },
              { createdAt: after.createdAt, id: { gt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    select: NODE_SELECT,
  });
}

interface RawChildRow {
  id: string;
  userId: string;
  busId: string | null;
  parentAgentId: string | null;
  depth: number;
  goal: string;
  status: string;
  createdAt: Date;
  backgroundTasks: Prisma.JsonValue;
  taskPath: string | null;
  toolsInUse: string[];
}

/**
 * First `perParent` live children of each parent in one round trip (LATERAL
 * over the (parentAgentId, createdAt) index), so expanding a level costs one
 * query regardless of how many parents it has.
 */
export async function findFirstChildrenOf(
  parentIds: string[],
  userId: string,
  perParent: number
): Promise<TreeNodeRow[]> {
  if (parentIds.length === 0) return [];
  const rows = await prisma.$queryRaw<RawChildRow[]>(Prisma.sql`
    SELECT c.id, c."userId", c."busId", c."parentAgentId", c.depth,
           LEFT(c.goal, ${TREE_GOAL_MAX_CHARS}::int) AS goal, c.status::text AS status, c."createdAt",
           c."backgroundTasks", c."taskPath", c."toolsInUse"
    FROM unnest(ARRAY[${Prisma.join(parentIds)}]::text[]) AS p(id)
    CROSS JOIN LATERAL (
      SELECT a.* FROM "Agent" a
      WHERE a."parentAgentId" = p.id AND a."userId" = ${userId} AND a."deletedAt" IS NULL
      ORDER BY a."createdAt" ASC, a.id ASC
      LIMIT ${perParent}::int
    ) c
    ORDER BY c."createdAt" ASC, c.id ASC
  `);
  return rows.map((row) => ({ ...row, deletedAt: null }) as TreeNodeRow);
}

export interface ChildCounts {
  total: number;
  active: number;
}

/** Direct-child totals (and non-terminal totals) for the listed parents only. */
export async function countDirectChildren(
  parentIds: string[],
  userId: string,
  terminalStatuses: ReadonlySet<string>
): Promise<Map<string, ChildCounts>> {
  const counts = new Map<string, ChildCounts>();
  if (parentIds.length === 0) return counts;
  const groups = await prisma.agent.groupBy({
    by: ['parentAgentId', 'status'],
    where: { parentAgentId: { in: parentIds }, userId, deletedAt: null },
    _count: { _all: true },
  });
  for (const group of groups) {
    if (group.parentAgentId === null) continue;
    const entry = counts.get(group.parentAgentId) ?? { total: 0, active: 0 };
    entry.total += group._count._all;
    if (!terminalStatuses.has(group.status)) entry.active += group._count._all;
    counts.set(group.parentAgentId, entry);
  }
  return counts;
}

/**
 * Live agents in one tree whose goal contains every token (case-insensitive)
 * and, with `pathPrefix`, whose task path is that path or below it. The busId
 * index narrows to one tree; the goal/path filters run over that tree only.
 */
export async function searchTreeByGoal(
  rootAgentId: string,
  userId: string,
  tokens: string[],
  limit: number,
  pathPrefix: string | null
): Promise<TreeNodeRow[]> {
  return prisma.agent.findMany({
    where: {
      OR: [{ id: rootAgentId }, { busId: rootAgentId }],
      userId,
      deletedAt: null,
      AND: [
        ...tokens.map((token) => ({ goal: { contains: token, mode: 'insensitive' as const } })),
        ...(pathPrefix !== null
          ? [
              {
                OR: [{ taskPath: pathPrefix }, { taskPath: { startsWith: `${pathPrefix}/` } }],
              },
            ]
          : []),
      ],
    },
    orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: NODE_SELECT,
  });
}
