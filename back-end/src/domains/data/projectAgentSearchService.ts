import { searchSharedProjectAgentRows } from './projectAgentRepo';
import type { GrepMatch, ValidatedGrepInput } from './types';

export async function searchSharedProjectAgents(userId: string, input: ValidatedGrepInput) {
  const { total, rows } = await searchSharedProjectAgentRows(userId, input);
  const matches: GrepMatch[] = rows.map((row) => {
    const path = `shared_project_agents/${row.projectId}/${row.id}`;
    return {
      source: 'shared_project_agents',
      path,
      pointer: path,
      timestamp: row.updatedAt.toISOString(),
      location: { source: 'shared_project_agents', path, agent_id: row.id },
      ownership: {
        owner_user_id: row.ownerUserId,
        owner_name: null,
        provider: 'shared_project',
        account_id: null,
        shared: true,
        team_ids: row.teamIds,
      },
      content: JSON.stringify({
        id: row.id,
        title: row.title,
        status: row.status,
        project_id: row.projectId,
        project_name: row.projectName,
        owner_user_id: row.ownerUserId,
        team_ids: row.teamIds,
      }),
    };
  });
  return { total, matches };
}
