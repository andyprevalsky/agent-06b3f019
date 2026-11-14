import * as repo from './repo';
import type { TeamAccessFilter, TeamDataGrant } from './types';
export async function resolveTeamDataAccess(
  userId: string,
  filters: TeamAccessFilter = {}
): Promise<TeamDataGrant[]> {
  const rows = await repo.integrationShares(userId, filters);
  const counts = await repo.imessageCounts([
    ...new Set(rows.filter((row) => row.provider === 'imessage').map((row) => row.ownerUserId)),
  ]);
  return rows.flatMap((row) => {
    const owner = row.team.members.find((member) => member.userId === row.ownerUserId);
    if (
      !owner ||
      row.integration.userId !== row.ownerUserId ||
      row.integration.name !== row.provider
    )
      return [];
    if (row.provider === 'imessage') {
      if (
        row.accountId !== '' ||
        row.integration.accountId !== '' ||
        row.accountEmail !== null ||
        counts.find((count) => count.userId === row.ownerUserId)?._count !== 1
      )
        return [];
    } else if (
      row.accountEmail === null ||
      row.accountEmail === '' ||
      row.accountId !== row.accountEmail ||
      !row.integration.emailCredentials.some(
        (credential) =>
          credential.userId === row.ownerUserId &&
          credential.provider.toLowerCase() === row.provider &&
          credential.email?.trim().toLowerCase() === row.accountEmail
      )
    )
      return [];
    return [
      {
        teamId: row.teamId,
        teamName: row.team.name,
        ownerUserId: row.ownerUserId,
        ownerName: owner.user?.name ?? null,
        integrationId: row.integrationId,
        provider: row.provider,
        accountId: row.accountId,
        accountEmail: row.accountEmail,
      },
    ];
  });
}
export async function listSharedProjects(userId: string) {
  const rows = await repo.projectShares(userId);
  return {
    projects: rows.flatMap((row) => {
      const owner = row.team.members.find((member) => member.userId === row.ownerUserId);
      if (!owner || row.project.userId !== row.ownerUserId) return [];
      const agents = row.project.agents.filter((agent) => agent.userId === row.ownerUserId);
      return [
        {
          id: row.id,
          projectId: row.projectId,
          teamId: row.teamId,
          teamName: row.team.name,
          ownerUserId: row.ownerUserId,
          ownerName: owner.user?.name ?? null,
          name: row.project.name,
          createdAt: row.createdAt.toISOString(),
          agents: agents.slice(0, 20).map((agent) => ({
            id: agent.id,
            title: agent.title,
            status: agent.status,
            projectId: row.projectId,
            ownerUserId: row.ownerUserId,
          })),
          hasMoreAgents: agents.length > 20,
        },
      ];
    }),
  };
}
export async function getTeamContext(userId: string) {
  return (await repo.memberships(userId)).map((member) => ({
    id: member.teamId,
    name: member.team.name,
    role: member.role,
  }));
}
