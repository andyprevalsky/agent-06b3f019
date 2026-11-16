/** Indexed owner-scoped lookups for agent project/folder placement. */
import { prisma } from '../../providers/database';
import { findSharedProjects } from '../../providers/projects/sharedProjects';

export async function findOwnedProjectIds(projectIds: string[], userId: string): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const rows = await prisma.project.findMany({
    where: { id: { in: projectIds }, userId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Of `projectIds`, those a team validly shares with `userId` (projects/sharedProjects.ts). */
export async function findSharedProjectIds(
  projectIds: string[],
  userId: string
): Promise<string[]> {
  return (await findSharedProjects(userId, projectIds)).map((project) => project.id);
}

export async function findOwnedFolders(folderIds: string[], userId: string) {
  if (folderIds.length === 0) return [];
  return prisma.projectFolder.findMany({
    where: { id: { in: folderIds }, project: { userId } },
    select: { id: true, projectId: true },
  });
}

export async function findParentPlacement(parentAgentId: string, userId: string) {
  return prisma.agent.findFirst({
    where: { id: parentAgentId, userId },
    select: { projectId: true, folderId: true },
  });
}

/** Parents' persisted repo refs (owner-scoped, one indexed query per batch). */
export async function findParentRepoRefs(parentAgentIds: string[], userId: string) {
  if (parentAgentIds.length === 0) return [];
  return prisma.agent.findMany({
    where: { id: { in: [...new Set(parentAgentIds)] }, userId },
    select: { id: true, githubRepoRef: true, githubRepoUrl: true },
  });
}
