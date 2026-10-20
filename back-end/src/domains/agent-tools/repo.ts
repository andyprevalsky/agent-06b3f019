import { Prisma } from '@prisma/client';
import { assertAttentionWorkflowTargets } from '../../providers/attentionWorkflowTargets';
import { prisma } from '../../providers/database';
import { DISPLAY_TREE_MAX_AGENTS, DISPLAY_TREE_MAX_DEPTH } from './config';

export interface ToolAgent {
  id: string;
  userId: string;
  parentAgentId: string | null;
  title: string | null;
  goal: string;
  temporalWorkflowId: string | null;
  deletedAt: Date | null;
}

const AGENT_SELECT = {
  id: true,
  userId: true,
  parentAgentId: true,
  title: true,
  goal: true,
  temporalWorkflowId: true,
  deletedAt: true,
} as const;

export async function findAgent(agentId: string): Promise<ToolAgent | null> {
  return prisma.agent.findUnique({ where: { id: agentId }, select: AGENT_SELECT });
}

export async function findMessage(id: string) {
  return prisma.message.findUnique({ where: { id } });
}

/**
 * Agent ids a `file` name may come from: the agent, its ancestors, and its
 * descendants (bounded depth and count), all owned by the same user.
 */
async function treeAgentIds(agent: ToolAgent): Promise<string[]> {
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
  agent: ToolAgent,
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

export async function findAttentionRequest(id: string) {
  return prisma.agentAttentionRequest.findUnique({ where: { id } });
}

/**
 * Create the attention row with a caller-derived id, or return the existing
 * one. The deterministic id makes a retried tool call (Temporal activity
 * retry, re-run CLI) land on the same request and the same answer.
 */
export async function createAttentionRequestOnce(data: {
  id: string;
  userId: string;
  agentId: string;
  workflowId: string;
  question: string;
  metadata: Record<string, unknown>;
}): Promise<{
  row: NonNullable<Awaited<ReturnType<typeof findAttentionRequest>>>;
  created: boolean;
}> {
  const existing = await findAttentionRequest(data.id);
  if (existing !== null) return { row: existing, created: false };
  try {
    const row = await prisma.agentAttentionRequest.create({
      data: { ...data, metadata: data.metadata as Prisma.InputJsonValue },
    });
    return { row, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await findAttentionRequest(data.id);
      if (winner !== null) return { row: winner, created: false };
    }
    throw error;
  }
}

/** The waiting workflow must be this agent's (same check the attention domain uses). */
export async function assertWorkflowTarget(
  userId: string,
  agentId: string,
  workflowId: string
): Promise<void> {
  await assertAttentionWorkflowTargets(prisma, userId, [{ agentId, workflowId }]);
}

/** The authored reply persisted with an answer (attention `user_message`), if any. */
export async function findAuthoredReply(
  requestId: string,
  agentId: string
): Promise<string | null> {
  const row = await prisma.message.findFirst({
    where: {
      agentId,
      role: 'USER',
      AND: [
        { metadata: { path: ['attentionRequestId'], equals: requestId } },
        { metadata: { path: ['source'], equals: 'attention_response' } },
      ],
    },
    orderBy: { timestamp: 'desc' },
    select: { text: true },
  });
  return row?.text ?? null;
}
