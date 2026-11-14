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
    select: {
      githubRepoUrl: true,
      githubRepoRef: true,
      userId: true,
      busId: true,
      projectId: true,
    },
  });
}

/**
 * Look up a root agent's GitHub repo URL and userId by busId.
 */
export async function findRootAgentGithubInfo(busId: string) {
  return prisma.agent.findUnique({
    where: { id: busId },
    select: { githubRepoUrl: true, githubRepoRef: true, userId: true, projectId: true },
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

/** The agent unless deleted (deletion only sets deletedAt): direct chat never resumes it. */
export async function findLiveAgentById(agentId: string) {
  return prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    select: { userId: true },
  });
}

/** Read the per-agent Fast Mode flag (used to decide ANTHROPIC_BASE_URL injection). */
export async function findAgentDemoCache(agentId: string): Promise<boolean> {
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
/** The owning Rose agent's run state and persisted background tasks (resume of a stopped code agent). */
export async function findAgentForCodeResume(agentId: string) {
  return prisma.agent.findFirst({
    // A deleted agent is never resumed (deletion only sets deletedAt).
    where: { id: agentId, deletedAt: null },
    select: {
      id: true,
      userId: true,
      model: true,
      status: true,
      temporalWorkflowId: true,
      backgroundTasks: true,
    },
  });
}

/**
 * A row that ended a resume of this spawn after `since`: a failure (ERROR, a
 * refused or failed resume) or the run's own terminal task_complete.
 */
export async function findResumeEndRow(agentId: string, toolCallId: string, since: Date) {
  return prisma.message.findFirst({
    where: {
      agentId,
      timestamp: { gt: since },
      AND: [
        { metadata: { path: ['toolCallId'], equals: toolCallId } },
        {
          OR: [
            { metadata: { path: ['toolStatus'], equals: 'ERROR' } },
            { metadata: { path: ['action_type'], equals: 'task_complete' } },
          ],
        },
      ],
    },
    select: { id: true },
  });
}

/** A persisted direct-turn row (its deterministic id), for a resent turn. */
export async function findDirectTurnRow(id: string) {
  return prisma.message.findUnique({
    where: { id },
    select: { id: true, metadata: true, timestamp: true },
  });
}

export async function findSessionForDirectChat(taskId: string) {
  return prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      agentId: true,
      status: true,
      streamUrl: true,
      codeSessionId: true,
      taskName: true,
    },
  });
}
