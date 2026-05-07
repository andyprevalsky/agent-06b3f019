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
