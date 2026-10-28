import { prisma } from '../../providers/database';

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

/** Fast Mode button + query-box speed for an agent (speed falls back to its tree root's). */
export async function findAgentCodexSpeedSource(
  agentId: string
): Promise<{ fastModeEnabled: boolean; speed: string | null }> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { fastModeCacheEnabled: true, fastModeSpeed: true, busId: true },
  });
  if (agent === null) return { fastModeEnabled: true, speed: null };
  let speed = agent.fastModeSpeed;
  if (speed === null && agent.busId !== null && agent.busId !== agentId) {
    const root = await prisma.agent.findUnique({
      where: { id: agent.busId },
      select: { fastModeSpeed: true },
    });
    speed = root?.fastModeSpeed ?? null;
  }
  return { fastModeEnabled: agent.fastModeCacheEnabled, speed };
}

/** Recover the selected credential's owner, including pooled credentials. */
export async function findCredentialIntegration(id: string) {
  return prisma.integration.findUnique({
    where: { id },
    select: { userId: true, accountId: true },
  });
}
