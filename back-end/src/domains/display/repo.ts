import { prisma } from '../../providers/database';
import { DISPLAY_TREE_MAX_AGENTS, DISPLAY_TREE_MAX_DEPTH } from './config';

export interface DisplayAgent {
  id: string;
  userId: string;
  parentAgentId: string | null;
}

export async function findAgent(agentId: string): Promise<DisplayAgent | null> {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, userId: true, parentAgentId: true },
  });
}

export async function findMessage(id: string) {
  return prisma.message.findUnique({ where: { id } });
}

/**
 * Agent ids a `file` name may come from: the agent, its ancestors, and its
 * descendants (bounded depth and count), all owned by the same user.
 */
async function treeAgentIds(agent: DisplayAgent): Promise<string[]> {
  const ids = new Set<string>([agent.id]);
  let parent = agent.parentAgentId;
  for (let depth = 0; parent !== null && depth < DISPLAY_TREE_MAX_DEPTH; depth += 1) {
    const row = await prisma.agent.findFirst({
      where: { id: parent, userId: agent.userId },
      select: { id: true, parentAgentId: true },
    });
    if (!row) break;
    ids.add(row.id);
    parent = row.parentAgentId;
  }
  let frontier = [agent.id];
  for (let depth = 0; frontier.length > 0 && depth < DISPLAY_TREE_MAX_DEPTH; depth += 1) {
    if (ids.size >= DISPLAY_TREE_MAX_AGENTS) break;
    const children = await prisma.agent.findMany({
      where: { parentAgentId: { in: frontier }, userId: agent.userId },
      select: { id: true },
      take: DISPLAY_TREE_MAX_AGENTS - ids.size,
    });
    frontier = children.map((child) => child.id).filter((id) => !ids.has(id));
    for (const id of frontier) ids.add(id);
  }
  return [...ids];
}

/** Most recent file pointer named `filename` in the agent's tree, or null. */
export async function findTreeFilePointer(
  agent: DisplayAgent,
  filename: string
): Promise<Record<string, unknown> | null> {
  const ids = await treeAgentIds(agent);
  const row = await prisma.message.findFirst({
    where: {
      agentId: { in: ids },
      filePointer: { path: ['original_filename'], equals: filename },
    },
    orderBy: { timestamp: 'desc' },
    select: { filePointer: true },
  });
  const pointer = row?.filePointer;
  return pointer !== null && typeof pointer === 'object' && !Array.isArray(pointer)
    ? (pointer as Record<string, unknown>)
    : null;
}
