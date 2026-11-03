/** Indexed owner-scoped lookups for agent project/folder placement. */
import { prisma } from '../../providers/database';

export async function findOwnedProjectIds(projectIds: string[], userId: string): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const rows = await prisma.project.findMany({
    where: { id: { in: projectIds }, userId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
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
