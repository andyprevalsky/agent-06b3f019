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
    select: { githubRepoUrl: true, userId: true, busId: true },
  });
}

/**
 * Look up a root agent's GitHub repo URL and userId by busId.
 */
export async function findRootAgentGithubInfo(busId: string) {
  return prisma.agent.findUnique({
    where: { id: busId },
    select: { githubRepoUrl: true, userId: true },
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
