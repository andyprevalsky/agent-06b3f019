/**
 * Root lookup for the agent graph: walk parentAgentId links (same user) from
 * one agent up to its tree root. O(depth) indexed primary-key reads, bounded
 * so a cycle or a corrupt chain can never run away.
 */
import { prisma } from '../database';

export const GRAPH_MAX_DEPTH = 64;

export async function findGraphRootId(agentId: string, userId: string): Promise<string | null> {
  let currentId: string | null = agentId;
  let rootId: string | null = null;
  const seen = new Set<string>();
  while (currentId !== null && !seen.has(currentId) && seen.size < GRAPH_MAX_DEPTH) {
    seen.add(currentId);
    const row: { parentAgentId: string | null } | null = await prisma.agent.findFirst({
      where: { id: currentId, userId },
      select: { parentAgentId: true },
    });
    if (row === null) break;
    rootId = currentId;
    currentId = row.parentAgentId;
  }
  return rootId;
}
