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

export async function findAgentDemoCache(agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { fastModeCacheEnabled: true },
  });
  return agent?.fastModeCacheEnabled ?? false;
}

/** Recover the selected credential's owner, including pooled credentials. */
export async function findCredentialIntegration(id: string) {
  return prisma.integration.findUnique({
    where: { id },
    select: { userId: true, accountId: true },
  });
}
