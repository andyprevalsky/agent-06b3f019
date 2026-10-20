/**
 * Agent-graph repo: tree membership, listing and code-session lookups.
 *
 * Every query is keyed by agent id / parentAgentId (indexed) and scoped to the
 * owning userId, so cost grows with the depth or size of ONE tree, never with
 * the number of agents a user or the system owns.
 */
import { prisma } from '../../providers/database';

/** Hard bounds: a tree walk can never run away on a cycle or a huge tree. */
export const GRAPH_MAX_DEPTH = 64;
export const GRAPH_MAX_NODES = 500;

export interface GraphAgentRow {
  id: string;
  userId: string;
  parentAgentId: string | null;
  status: string;
  title: string | null;
  goal: string;
  createdAt: Date;
}

const agentSelect = {
  id: true,
  userId: true,
  parentAgentId: true,
  status: true,
  title: true,
  goal: true,
  createdAt: true,
} as const;

export async function findGraphAgent(agentId: string): Promise<GraphAgentRow | null> {
  return prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    select: agentSelect,
  });
}

/** Walk up parentAgentId links (same user) and return the root id. */
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

/** BFS from the root (level by level), capped at GRAPH_MAX_NODES. */
export async function listGraphTreeAgents(
  rootId: string,
  userId: string
): Promise<Array<GraphAgentRow & { treeDepth: number }>> {
  const root = await prisma.agent.findFirst({
    where: { id: rootId, userId, deletedAt: null },
    select: agentSelect,
  });
  if (root === null) return [];
  const out: Array<GraphAgentRow & { treeDepth: number }> = [{ ...root, treeDepth: 0 }];
  const seen = new Set([root.id]);
  let frontier = [root.id];
  let depth = 0;
  while (frontier.length > 0 && out.length < GRAPH_MAX_NODES && depth < GRAPH_MAX_DEPTH) {
    depth += 1;
    const children = await prisma.agent.findMany({
      where: { parentAgentId: { in: frontier }, userId, deletedAt: null },
      select: agentSelect,
      orderBy: { createdAt: 'asc' },
      take: GRAPH_MAX_NODES - out.length,
    });
    frontier = [];
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ ...child, treeDepth: depth });
      frontier.push(child.id);
    }
  }
  return out;
}

export interface GraphCodeSessionRow {
  id: string;
  agentId: string;
  status: string;
  goal: string;
  streamUrl: string | null;
  createdAt: Date;
}

const codeSessionSelect = {
  id: true,
  agentId: true,
  status: true,
  goal: true,
  streamUrl: true,
  createdAt: true,
} as const;

export async function listGraphCodeSessions(agentIds: string[]): Promise<GraphCodeSessionRow[]> {
  if (agentIds.length === 0) return [];
  return prisma.claudeCodeSession.findMany({
    where: { agentId: { in: agentIds } },
    select: codeSessionSelect,
    orderBy: { createdAt: 'asc' },
    take: GRAPH_MAX_NODES,
  });
}

export async function findGraphCodeSession(sessionId: string): Promise<GraphCodeSessionRow | null> {
  return prisma.claudeCodeSession.findUnique({
    where: { id: sessionId },
    select: codeSessionSelect,
  });
}

/** The spawn tool call that owns a code session's chips on its parent agent. */
export async function findCodeSessionToolCallId(
  ownerAgentId: string,
  sessionId: string
): Promise<string | null> {
  const row = await prisma.message.findFirst({
    where: { agentId: ownerAgentId, metadata: { path: ['task_id'], equals: sessionId } },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
  const metadata = row?.metadata;
  if (metadata === null || metadata === undefined || typeof metadata !== 'object') return null;
  const toolCallId = (metadata as Record<string, unknown>).toolCallId;
  return typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : null;
}

export async function findMessageById(id: string) {
  return prisma.message.findUnique({ where: { id }, select: { id: true, agentId: true } });
}
