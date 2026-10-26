import { prisma } from '../../providers/database';
import { repoKeyFor } from '../../providers/codeSessions/store';

export async function ownedPreviewAgent(userId: string, id: string) {
  return prisma.agent.findFirst({
    where: { id, userId, deletedAt: null },
    select: {
      id: true,
      busId: true,
      parentAgentId: true,
      githubRepoUrl: true,
      project: { select: { userId: true, repoUrl: true } },
    },
  });
}

export async function primaryRootPreviewSession(
  userId: string,
  rootId: string,
  repoUrl: string | null
) {
  return prisma.codeSession.findFirst({
    where: {
      userId,
      rootAgentId: rootId,
      ownerAgentId: rootId,
      repoKey: repoKeyFor(repoUrl),
      parentCodeSessionId: null,
      state: { not: 'RETIRED' },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, state: true, sandboxKind: true, sandboxId: true, homeDir: true },
  });
}

export async function latestRootPreviewTask(rootId: string, codeSessionId: string) {
  return prisma.claudeCodeSession.findFirst({
    where: { codeSessionId, agentId: rootId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, sandboxId: true, streamUrl: true },
  });
}
