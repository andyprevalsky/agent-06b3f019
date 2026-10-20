/**
 * Claude Code domain repo — all Prisma calls.
 */

import { prisma } from '../../providers/database';

/**
 * Look up an agent's GitHub repo URL and userId.
 * Returns the agent record or null.
 */
export async function findAgentGithubInfo(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { githubRepoUrl: true, userId: true, busId: true, projectId: true },
  });
}

/**
 * Look up a root agent's GitHub repo URL and userId by busId.
 */
export async function findRootAgentGithubInfo(busId: string) {
  return prisma.agent.findUnique({
    where: { id: busId },
    select: { githubRepoUrl: true, userId: true, projectId: true },
  });
}

/**
 * Find all Claude Code sessions for a given agent.
 */
export async function findSessionsByAgent(agentId: string) {
  return prisma.claudeCodeSession.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
}

/**
 * Persist terminal output for a completed Claude Code session.
 */
export async function persistSessionOutput(taskId: string, output: string) {
  return prisma.claudeCodeSession.update({
    where: { id: taskId },
    data: {
      output,
      status: 'COMPLETED',
      closedAt: new Date(),
    },
  });
}

/**
 * Find a Claude Code session by id (used to look up credential tracking metadata
 * after the CLI has finished, so we can mark the right Integration rate-limited
 * if the output reports exhaustion).
 */
export async function findSessionById(taskId: string) {
  return prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      agentId: true,
      claudeTokenSource: true,
      claudeTokenIntegrationId: true,
    },
  });
}

/**
 * Look up the user that owns an agent (needed to mark a user-owned token
 * rate-limited when Claude Code reports exhaustion on a user-source session).
 */
export async function findAgentById(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { userId: true },
  });
}

/** Read the per-agent Fast Mode flag (used to decide ANTHROPIC_BASE_URL injection). */
export async function findAgentFastModeCache(agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { fastModeCacheEnabled: true },
  });
  return agent?.fastModeCacheEnabled ?? false;
}

/**
 * The code session's spawn chip (its first row): the tool call that renders it
 * and the CLI provider. One indexed per-agent lookup.
 */
export async function findCodeSessionChip(
  agentId: string,
  taskId: string
): Promise<{ toolCallId: string | null; provider: 'claude' | 'codex' }> {
  const row = await prisma.message.findFirst({
    where: { agentId, metadata: { path: ['task_id'], equals: taskId } },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
  const fields =
    row?.metadata !== null && typeof row?.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    toolCallId:
      typeof fields.toolCallId === 'string' && fields.toolCallId !== '' ? fields.toolCallId : null,
    provider: fields.code_provider === 'codex' ? 'codex' : 'claude',
  };
}

/** Session fields needed to address a live code session for direct chat. */
export async function findSessionForDirectChat(taskId: string) {
  return prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: { id: true, agentId: true, status: true, streamUrl: true },
  });
}
