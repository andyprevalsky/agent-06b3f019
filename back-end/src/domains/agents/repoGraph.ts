/**
 * Agent-graph repo: tree membership, listing and code-session lookups.
 *
 * Every query is keyed by agent id / parentAgentId (indexed) and scoped to the
 * owning userId, so cost grows with the depth or size of ONE tree, never with
 * the number of agents a user or the system owns.
 */
import { prisma } from '../../providers/database';
import { GRAPH_MAX_DEPTH, findGraphRootId } from '../../providers/agentGraph/tree';

/** Hard bounds: a tree walk can never run away on a cycle or a huge tree. */
export { GRAPH_MAX_DEPTH };
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
export { findGraphRootId };

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
  /** 'claude' | 'codex'; null for legacy rows created before persistent sessions. */
  codeProvider: string | null;
}

const codeSessionSelect = {
  id: true,
  agentId: true,
  status: true,
  goal: true,
  streamUrl: true,
  createdAt: true,
  codeProvider: true,
} as const;

/** Most root ids one code-agents list request may name. */
export const CODE_AGENT_LIST_MAX_ROOTS = 50;
const CODE_AGENT_LIST_MAX_ROWS = 500;

export interface RootCodeAgentRow extends GraphCodeSessionRow {
  rootAgentId: string;
}

/**
 * Code agents of the caller's trees, one indexed join for every requested
 * root (Agent.busId = the root for every agent in a tree, the root included).
 */
export async function listCodeAgentsForRoots(
  userId: string,
  rootIds: string[]
): Promise<RootCodeAgentRow[]> {
  if (rootIds.length === 0) return [];
  return prisma.$queryRaw<RootCodeAgentRow[]>`
    SELECT c.id, c."agentId", c.status::text AS status, c.goal, c."streamUrl", c."createdAt",
           c."codeProvider", a."busId" AS "rootAgentId"
    FROM "ClaudeCodeSession" c
    JOIN "Agent" a ON a.id = c."agentId"
    WHERE a."userId" = ${userId} AND a."busId" = ANY(${rootIds}::text[])
    ORDER BY c."createdAt" ASC
    LIMIT ${CODE_AGENT_LIST_MAX_ROWS}
  `;
}

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

export interface CodeSessionChip {
  /** The spawn tool call whose chip renders this code session. */
  toolCallId: string | null;
  provider: 'claude' | 'codex' | null;
}

/** Spawn-chip facts for a code session: its tool call id and CLI provider. */
export async function findCodeSessionChip(
  ownerAgentId: string,
  sessionId: string
): Promise<CodeSessionChip> {
  const row = await prisma.message.findFirst({
    where: { agentId: ownerAgentId, metadata: { path: ['task_id'], equals: sessionId } },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
  const metadata = row?.metadata;
  if (metadata === null || metadata === undefined || typeof metadata !== 'object') {
    return { toolCallId: null, provider: null };
  }
  const fields = metadata as Record<string, unknown>;
  const toolCallId =
    typeof fields.toolCallId === 'string' && fields.toolCallId.length > 0
      ? fields.toolCallId
      : null;
  const provider =
    fields.code_provider === 'claude' || fields.code_provider === 'codex'
      ? fields.code_provider
      : null;
  return { toolCallId, provider };
}

export async function findMessageById(id: string) {
  return prisma.message.findUnique({ where: { id }, select: { id: true, agentId: true } });
}
