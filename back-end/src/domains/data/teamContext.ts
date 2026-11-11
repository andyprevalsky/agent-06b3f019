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
    projectAgents: projects.flatMap((project) =>
      project.agents.map(({ id, title, status, projectId, ownerUserId }) => ({
        id,
        title,
        status,
        projectId,
        ownerUserId,
        teamId: project.teamId,
      }))
    ),
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
    projects: projects.map(({ projectId, teamId, teamName, ownerUserId, name, hasMoreAgents }) => ({
      projectId,
      teamId,
      teamName,
      ownerUserId,
      name,
      hasMoreAgents,
    })),
  };
}

export function formatSharedDataMap(map: Awaited<ReturnType<typeof getSharedDataMap>>): string {
  if (map.teams.length === 0) return '';
  return (
    'CONNECTED TEAMS AND SHARED DATA MAP:\n' +
    JSON.stringify(map) +
    '\nGrep defaults to own + explicit team account grants. Use scope, team_id, owner_user_id, account_id to narrow. ' +
    'Use grep source=shared_project_agents with filters.project_id to search/page beyond the shown agents. Shared projects allow discovery only; they grant no credentials, iPhone access or other account data.'
  );
}
