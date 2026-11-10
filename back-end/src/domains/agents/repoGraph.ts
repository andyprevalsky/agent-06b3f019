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
/** Newest code agents listed per requested root (so at most 50 x 50 rows). */
export const CODE_AGENT_LIST_PER_ROOT = 50;

/** Rename one task atomically with its owning user's scope; never alter the CLI session. */
export async function renameCodeAgentForUser(
  userId: string,
  taskId: string,
  title: string
): Promise<{ code_agent_id: string; title: string } | null> {
  const rows = await prisma.$queryRaw<Array<{ code_agent_id: string; title: string }>>`
    UPDATE "ClaudeCodeSession" c
    SET "taskName" = ${title}
    FROM "Agent" a
    WHERE c.id = ${taskId} AND a.id = c."agentId"
      AND a."userId" = ${userId} AND a."deletedAt" IS NULL
    RETURNING c.id AS code_agent_id, c."taskName" AS title
  `;
  return rows[0] ?? null;
}

export interface RootCodeAgentRow extends GraphCodeSessionRow {
  rootAgentId: string;
  codeSessionId: string | null;
  /** close | failure | cancel | idle | awaiting_parent | usage_limit; null for legacy rows. */
  closeReason: string | null;
  awaitingParent: unknown;
  /** The task is the newest of a code session that is not retired. */
  latestOfLiveSession: boolean;
  /** The spawn's task_name; null for legacy rows and internal callers. */
  taskName: string | null;
  /** Its persistent code session's state (ACTIVE | PAUSED | RETIRED); null without one. */
  sessionState: string | null;
  /** That session's last keepalive (spawn keepalive / lease extension); null without one. */
  sessionLastActiveAt: Date | null;
  /** Some task of that session (this one or a later spawn attached to it) is running. */
  sessionHasActiveTask: boolean;
}

/**
 * Code agents of the caller's trees, newest first, at most
 * CODE_AGENT_LIST_PER_ROOT per root: one query for every requested root
 * (Agent.busId = the root for every agent in a tree, the root included), so a
 * busy tree never pushes its newest agents, or another root's, off the list.
 */
export async function listCodeAgentsForRoots(
  userId: string,
  rootIds: string[]
): Promise<RootCodeAgentRow[]> {
  if (rootIds.length === 0) return [];
  return prisma.$queryRaw<RootCodeAgentRow[]>`
    SELECT r.id, r."agentId", r.status, r.goal, r."streamUrl", r."createdAt", r."codeProvider",
           r."rootAgentId", r."codeSessionId", r."closeReason", r."awaitingParent", r."taskName",
           cs.state AS "sessionState", cs."lastActiveAt" AS "sessionLastActiveAt",
           EXISTS (
             SELECT 1 FROM "ClaudeCodeSession" n
             WHERE n."codeSessionId" = r."codeSessionId" AND n.status = 'ACTIVE'
           ) AS "sessionHasActiveTask",
           (cs.id IS NOT NULL AND cs.state <> 'RETIRED' AND NOT EXISTS (
             SELECT 1 FROM "ClaudeCodeSession" n
             WHERE n."codeSessionId" = r."codeSessionId" AND n."createdAt" > r."createdAt"
           )) AS "latestOfLiveSession"
    FROM (
      SELECT c.id, c."agentId", c.status::text AS status, c.goal, c."streamUrl", c."createdAt",
             c."codeProvider", c."codeSessionId", c."closeReason", c."awaitingParent", c."taskName",
             a."busId" AS "rootAgentId",
             ROW_NUMBER() OVER (PARTITION BY a."busId" ORDER BY c."createdAt" DESC, c.id DESC) AS rank
      FROM "ClaudeCodeSession" c
      JOIN "Agent" a ON a.id = c."agentId"
      WHERE a."userId" = ${userId} AND a."busId" = ANY(${rootIds}::text[])
    ) r
    LEFT JOIN "CodeSession" cs ON cs.id = r."codeSessionId"
    WHERE r.rank <= ${CODE_AGENT_LIST_PER_ROOT}
    ORDER BY r."createdAt" DESC, r.id DESC
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

/**
 * The newest code session a spawn tool call ran since `since` (the task's
 * current run; earlier runs reuse the tool call id). The activity's rows carry
 * toolCallId + task_id; reads one owner's rows from `since` on through the
 * (agentId, timestamp) index. Null when this run has not started a session.
 */
export async function findCodeSessionForToolCall(
  ownerAgentId: string,
  toolCallId: string,
  since: Date | null
): Promise<GraphCodeSessionRow | null> {
  const rows = await prisma.message.findMany({
    where: {
      agentId: ownerAgentId,
      ...(since !== null ? { timestamp: { gte: since } } : {}),
      metadata: { path: ['toolCallId'], equals: toolCallId },
    },
    orderBy: { timestamp: 'desc' },
    take: CODE_SESSION_ROW_SCAN,
    select: { metadata: true },
  });
  for (const row of rows) {
    const sessionId = (row.metadata as Record<string, unknown> | null)?.task_id;
    if (typeof sessionId !== 'string' || sessionId === '') continue;
    const session = await findGraphCodeSession(sessionId);
    return session !== null && session.agentId === ownerAgentId ? session : null;
  }
  return null;
}

/** Newest rows of one tool call read to find its session (every activity row names it). */
const CODE_SESSION_ROW_SCAN = 20;

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

/** The owner's received row for one agent turn to its code session (one agent's rows only). */
export async function findCodeTurnRow(ownerAgentId: string, codeTurnId: string) {
  return prisma.message.findFirst({
    where: { agentId: ownerAgentId, metadata: { path: ['code_turn_id'], equals: codeTurnId } },
    select: { id: true, metadata: true },
  });
}

export async function findMessageById(id: string) {
  return prisma.message.findUnique({ where: { id }, select: { id: true, agentId: true } });
}
