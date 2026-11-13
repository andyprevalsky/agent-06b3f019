/**
 * Agent -> optional project -> optional one-level folder -> connected repo ref.
 * Explicit folder derives its owned project; contradictory project is rejected.
 * Omitted child placement inherits both; explicit project resets folder;
 * explicit null folder keeps the inherited/current project and selects its root.
 * Two indexed bulk queries per batch; no N+1 per child or shared hot-path row.
 *
 * Repo ref (Agent.githubRepoRef, the fix for new agents losing their project's
 * GitHub repo), precedence in providers/githubRepos/resolve.ts:
 *   explicit github_repo_ref > trusted server repo > explicit project's repo >
 *   parent's ref > inherited project's repo.
 * One indexed parent query per create/batch; one lookup per distinct project.
 */
import {
  GithubRepoRefNotFoundError,
  resolveAgentRepoRef,
  type AgentRepoRefFields,
} from '../../providers/githubRepos/resolve';
import type { CreateAgentBody } from './types';
import {
  findOwnedProjectIds,
  findOwnedFolders,
  findParentPlacement,
  findParentRepoRefs,
} from './repoAgentProjects';

export class AgentProjectNotFoundError extends Error {
  constructor(message = 'Project not found') {
    super(message);
    this.name = 'AgentProjectNotFoundError';
  }
}

/** Typed 404 code for an explicit `github_repo_ref` the user has not connected. */
export const GITHUB_REPO_NOT_CONNECTED_CODE = 'GITHUB_REPO_NOT_CONNECTED';

/** The explicit repo ref is not connected: a 404 that carries a typed `code`. */
export class AgentGithubRepoNotConnectedError extends AgentProjectNotFoundError {
  readonly code = GITHUB_REPO_NOT_CONNECTED_CODE;
  constructor(readonly ref: string) {
    super(`GitHub repo ${ref} is not connected for this user`);
    this.name = 'AgentGithubRepoNotConnectedError';
  }
}

/** JSON body of an AgentProjectNotFoundError response (typed code when it has one). */
export function agentProjectNotFoundBody(error: AgentProjectNotFoundError) {
  return error instanceof AgentGithubRepoNotConnectedError
    ? { error: error.message, code: error.code }
    : { error: error.message };
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

/** The body named its placement (read before placement resolution overwrites project_id). */
function hasExplicitPlacement(body: CreateAgentBody): boolean {
  return typeof body.project_id === 'string' || typeof body.folder_id === 'string';
}

export async function resolveCreateAgentPlacement(body: CreateAgentBody, userId: string) {
  const explicitProject = hasExplicitPlacement(body);
  const inherited =
    body.parent_agent_id !== undefined
      ? await findParentPlacement(body.parent_agent_id, userId)
      : null;
  return { ...(await resolveAgentPlacement(body, userId, inherited ?? HOME)), explicitProject };
}

async function asPlacementError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GithubRepoRefNotFoundError) {
      throw new AgentGithubRepoNotConnectedError(error.ref);
    }
    throw error;
  }
}

/** Repo ref fields of one new agent with resolved placement (404 for an unconnected ref). */
export async function resolveCreateRepoFields(
  body: CreateAgentBody,
  userId: string,
  placement: { projectId: string | null; explicitProject: boolean },
  serverRepoUrl?: string
): Promise<AgentRepoRefFields> {
  const [parent] =
    body.parent_agent_id !== undefined
      ? await findParentRepoRefs([body.parent_agent_id], userId)
      : [];
  return asPlacementError(() =>
    resolveAgentRepoRef(userId, {
      explicitRef: body.github_repo_ref,
      serverRepoUrl,
      projectId: placement.projectId,
      explicitProject: placement.explicitProject,
      parent: parent ?? null,
    })
  );
}

/** Per agent_id repo fields for a batch whose placement is already resolved. */
export async function resolveBatchRepoFields(
  bodies: CreateAgentBody[],
  userId: string,
  explicitPlacementIds: ReadonlySet<string>
): Promise<Map<string, AgentRepoRefFields>> {
  const parents = await findParentRepoRefs(
    bodies.flatMap((body) => (body.parent_agent_id !== undefined ? [body.parent_agent_id] : [])),
    userId
  );
  const parentById = new Map(parents.map((parent) => [parent.id, parent]));
  const projectCache = new Map();
  const fields = new Map<string, AgentRepoRefFields>();
  for (const body of bodies) {
    const parent =
      body.parent_agent_id !== undefined ? parentById.get(body.parent_agent_id) : undefined;
    const input = {
      explicitRef: body.github_repo_ref,
      projectId: typeof body.project_id === 'string' ? body.project_id : null,
      explicitProject: explicitPlacementIds.has(body.agent_id!),
      parent: parent ?? null,
    };
    fields.set(
      body.agent_id!,
      await asPlacementError(() => resolveAgentRepoRef(userId, input, projectCache))
    );
  }
  return fields;
}

/**
 * Resolve all explicit IDs together using the already-loaded parent rows, then
 * each agent's repo ref fields (keyed by agent_id).
 */
export async function resolveBatchProjectIds(
  bodies: CreateAgentBody[],
  userId: string,
  parentById: Map<string, Placement>
): Promise<Map<string, AgentRepoRefFields>> {
  const explicitPlacementIds = new Set(
    bodies.filter(hasExplicitPlacement).map((body) => body.agent_id!)
  );
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
  return resolveBatchRepoFields(bodies, userId, explicitPlacementIds);
}

export interface BatchAgentResult {
  project_id: string | null;
  folder_id: string | null;
  /** Persisted Agent.githubRepoRef (canonical `gh:owner/repo`), null when none. */
  github_repo_ref?: string | null;
  agent_id: string;
  status: 'STARTING_UP' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'FAILED';
  temporal_workflow_id: string | null;
  goal?: string;
  model?: string;
  error?: string;
  already_existed?: boolean;
}

type StoredBatchAgent = {
  id: string;
  projectId: string | null;
  folderId: string | null;
  githubRepoRef: string | null;
  status: string;
  temporalWorkflowId: string | null;
  goal: string;
  model: string;
};

/**
 * Batch results in input order, each with its persisted repo ref. Existing
 * rows surface their stored status; a pending retry keeps its first create's ref.
 */
export function batchAgentResults(
  bodies: CreateAgentBody[],
  created: Map<string, BatchAgentResult>,
  existingById: Map<string, StoredBatchAgent>,
  repoFields: Map<string, AgentRepoRefFields>
): BatchAgentResult[] {
  return bodies.map((body) => {
    const agentId = body.agent_id!;
    const stored = existingById.get(agentId);
    const ref =
      stored !== undefined ? stored.githubRepoRef : repoFields.get(agentId)?.githubRepoRef;
    const result = created.get(agentId);
    if (result) return { ...result, github_repo_ref: ref ?? null };
    const row = stored!;
    return {
      agent_id: row.id,
      project_id: row.projectId,
      folder_id: row.folderId,
      github_repo_ref: row.githubRepoRef,
      status: row.status as BatchAgentResult['status'],
      temporal_workflow_id: row.temporalWorkflowId,
      goal: row.goal,
      model: row.model,
      already_existed: true,
    };
  });
}
