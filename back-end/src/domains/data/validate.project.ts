import { InvalidGrepParamError } from './errors';

export function parseProjectAgentFilters(filters: Record<string, unknown>) {
  let projectId = filters.project_id;
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.trim() === '')) {
    throw new InvalidGrepParamError('filters.project_id', 'Expected an exact shared project ID.');
  }
  let agentId: string | undefined;
  if (filters.path !== undefined) {
    const path =
      typeof filters.path === 'string'
        ? /^shared_project_agents\/([^/]+)(?:\/([^/]+))?\/?$/.exec(filters.path)
        : null;
    if (path === null || (projectId !== undefined && projectId !== path[1])) {
      throw new InvalidGrepParamError(
        'filters.path',
        'Use the shared_project_agents path returned by grep.'
      );
    }
    projectId = path[1];
    agentId = path[2];
  }
  return { projectId: typeof projectId === 'string' ? projectId.trim() : undefined, agentId };
}
