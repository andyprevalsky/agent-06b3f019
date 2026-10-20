/**
 * Project lookups for agent creation (Agent.projectId). Owner-scoped: a
 * project id the caller does not own resolves to nothing.
 */
import { prisma } from '../../providers/database';

/** Subset of `projectIds` owned by `userId` (one indexed query). */
export async function findOwnedProjectIds(projectIds: string[], userId: string): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const rows = await prisma.project.findMany({
    where: { id: { in: projectIds }, userId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** The parent agent's project (owner-scoped), or null. */
export async function findParentProjectId(
  parentAgentId: string,
  userId: string
): Promise<string | null> {
  const parent = await prisma.agent.findFirst({
    where: { id: parentAgentId, userId },
    select: { projectId: true },
  });
  return parent?.projectId ?? null;
}
