/** Read-only team map. No account config, credentials, or project execution data. */
import {
  getTeamContext,
  listSharedProjects,
  resolveTeamDataAccess,
} from '../../providers/teamAccess';

export async function getSharedDataMap(userId: string) {
  const [teams, grants, { projects }] = await Promise.all([
    getTeamContext(userId),
    resolveTeamDataAccess(userId),
    listSharedProjects(userId),
  ]);
  return {
    you: { userId },
    teams: teams.map(({ id, name, role }) => ({ id, name, role })),
    accounts: grants
      .filter(
        (grant) =>
          (grant.provider === 'gmail' && Boolean(grant.accountEmail)) ||
          (grant.provider === 'imessage' && grant.accountId === '')
      )
      .map(({ teamId, ownerUserId, ownerName, provider, accountId, accountEmail }) => ({
        teamId,
        ownerUserId,
        ownerName,
        provider,
        accountId,
        accountEmail,
      })),
    projects: projects.map(({ projectId, teamId, teamName, ownerUserId, name }) => ({
      projectId,
      teamId,
      teamName,
      ownerUserId,
      name,
    })),
  };
}

export function formatSharedDataMap(map: Awaited<ReturnType<typeof getSharedDataMap>>): string {
  if (map.teams.length === 0) return '';
  return (
    'CONNECTED TEAMS AND SHARED DATA MAP:\n' +
    JSON.stringify(map) +
    '\ngrep and list_agents cover this shared data; filter by owner_user_id, team_id, account_id or project_id. Use exact ids; never guess identities.'
  );
}
