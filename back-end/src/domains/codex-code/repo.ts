import { prisma } from '../../providers/database';
import { agentSpeedFromRow, type AgentSpeed } from '../../providers/rose/speed';

export async function findAgentGithubInfo(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { githubRepoUrl: true, userId: true, busId: true },
  });
}

export async function findRootAgentGithubInfo(busId: string) {
  return prisma.agent.findUnique({
    where: { id: busId },
    select: { githubRepoUrl: true, userId: true },
  });
}

export async function findSessionsByAgent(agentId: string) {
  return prisma.claudeCodeSession.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
}

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

/** The run switched from its ChatGPT login to the funded Azure deployment (C15 marks follow it). */
export async function markSessionServedByAzure(taskId: string) {
  await prisma.claudeCodeSession.update({
    where: { id: taskId },
    data: { claudeTokenSource: 'azure' },
  });
}

export async function findSessionById(taskId: string) {
  return prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      claudeTokenSource: true,
      claudeTokenIntegrationId: true,
    },
  });
}

/**
 * A Codex session agent's speed (Agent.speed). A row created before that
 * column existed carries null and takes its tree root's speed instead.
 */
export async function findAgentSpeed(agentId: string): Promise<AgentSpeed> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { speed: true, fastModeCacheEnabled: true, busId: true },
  });
  if (agent === null) return 'fast';
  if (agent.speed !== null || agent.busId === null || agent.busId === agentId) {
    return agentSpeedFromRow(agent);
  }
  const root = await prisma.agent.findUnique({
    where: { id: agent.busId },
    select: { speed: true, fastModeCacheEnabled: true },
  });
  return agentSpeedFromRow(root ?? agent);
}

/** Recover the selected credential's owner, including pooled credentials. */
export async function findCredentialIntegration(id: string) {
  return prisma.integration.findUnique({
    where: { id },
    select: { userId: true, accountId: true },
  });
}
