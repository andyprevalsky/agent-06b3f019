/**
 * Agent -> optional project -> optional one-level folder.
 * Explicit folder derives its owned project; contradictory project is rejected.
 * Omitted child placement inherits both; explicit project resets folder;
 * explicit null folder keeps the inherited/current project and selects its root.
 * Two indexed bulk queries per batch; no N+1 per child or shared hot-path row.
 */
import type { CreateAgentBody } from './types';
import { findOwnedProjectIds, findOwnedFolders, findParentPlacement } from './repoAgentProjects';

export class AgentProjectNotFoundError extends Error {
  constructor(message = 'Project not found') {
    super(message);
    this.name = 'AgentProjectNotFoundError';
  }
}

export class AgentPlacementConflictError extends Error {
  constructor() {
    super('Folder does not belong to the requested project');
    this.name = 'AgentPlacementConflictError';
  }
}

type PlacementRequest = { project_id?: string | null; folder_id?: string | null };
type Placement = { projectId: string | null; folderId: string | null };
const HOME: Placement = { projectId: null, folderId: null };

function resolvePlacement(
  body: PlacementRequest,
  inherited: Placement,
  ownedProjects: Set<string>,
  folders: Map<string, string>
): Placement {
  if (typeof body.project_id === 'string' && !ownedProjects.has(body.project_id)) {
    throw new AgentProjectNotFoundError();
  }
  if (typeof body.folder_id === 'string') {
    const projectId = folders.get(body.folder_id);
    if (projectId === undefined) throw new AgentProjectNotFoundError('Folder not found');
    if (body.project_id !== undefined && body.project_id !== projectId) {
      throw new AgentPlacementConflictError();
    }
    return { projectId, folderId: body.folder_id };
  }
  if (body.project_id !== undefined) return { projectId: body.project_id, folderId: null };
  return {
    projectId: inherited.projectId,
    folderId: body.folder_id === null ? null : inherited.folderId,
  };
}

export async function resolveAgentPlacement(
  body: PlacementRequest,
  userId: string,
  inherited: Placement = HOME
): Promise<Placement> {
  const [projects, folders] = await Promise.all([
    findOwnedProjectIds(typeof body.project_id === 'string' ? [body.project_id] : [], userId),
    findOwnedFolders(typeof body.folder_id === 'string' ? [body.folder_id] : [], userId),
  ]);
  return resolvePlacement(
    body,
    inherited,
    new Set(projects),
    new Map(folders.map((f) => [f.id, f.projectId]))
  );
}

export async function resolveCreateAgentPlacement(body: CreateAgentBody, userId: string) {
  const inherited =
    body.parent_agent_id !== undefined
      ? await findParentPlacement(body.parent_agent_id, userId)
      : null;
  return resolveAgentPlacement(body, userId, inherited ?? HOME);
}

/** Resolve all explicit IDs together using the already-loaded parent rows. */
export async function resolveBatchProjectIds(
  bodies: CreateAgentBody[],
  userId: string,
  parentById: Map<string, Placement>
): Promise<void> {
  const projectIds = [
    ...new Set(bodies.flatMap((b) => (typeof b.project_id === 'string' ? [b.project_id] : []))),
  ];
  const folderIds = [
    ...new Set(bodies.flatMap((b) => (typeof b.folder_id === 'string' ? [b.folder_id] : []))),
  ];
  const [projects, folders] = await Promise.all([
    findOwnedProjectIds(projectIds, userId),
    findOwnedFolders(folderIds, userId),
  ]);
  const owned = new Set(projects);
  const folderMap = new Map(folders.map((f) => [f.id, f.projectId]));
  for (const body of bodies) {
    const inherited =
      body.parent_agent_id !== undefined ? parentById.get(body.parent_agent_id) : undefined;
    const placement = resolvePlacement(body, inherited ?? HOME, owned, folderMap);
    body.project_id = placement.projectId;
    body.folder_id = placement.folderId;
  }
}

export interface BatchAgentResult {
  project_id: string | null;
  folder_id: string | null;
  agent_id: string;
  status: 'STARTING_UP' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'FAILED';
  temporal_workflow_id: string | null;
  goal?: string;
  model?: string;
  error?: string;
  already_existed?: boolean;
}
