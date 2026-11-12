/**
 * Resolve repo refs to the caller's active connections (server-side permission).
 *
 *   ref spelling                      resolves through
 *   gh:owner/repo | GitHub URL        the user's GithubRepoConnection (canonical ref)
 *   <project uuid> | rose-project:<id> the project's repoUrl → its connection (legacy)
 *
 * A ref the user has no connection for resolves to null: a foreign user's repo,
 * a disconnected repo and a missing one are indistinguishable.
 *
 * Agent creation (resolveAgentRepoRef) precedence, highest first:
 *   explicit `github_repo_ref` (null = explicitly none) > trusted server repo URL >
 *   explicit project placement's repo > parent agent's ref > inherited project's repo.
 */
import { resolveSessionProject } from '../projects/session';
import type { ProjectWorkspace } from '../projects/types';
import {
  ROSE_PROJECT_REPO_PREFIX,
  canonicalGithubRepoRef,
  githubRepoIdentity,
  sameGithubRepo,
} from './refs';
import {
  findGithubRepoConnection,
  findOwnedProjectRepo,
  importLegacyProjectConnections,
  type GithubRepoConnectionRecord,
} from './store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GithubRepoRefNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly ref: string) {
    super(`GitHub repo ${ref} is not connected for this user`);
    this.name = 'GithubRepoRefNotFoundError';
  }
}

/** Connection of the repo a project (folder) carries; imports a legacy connection once. */
export async function projectRepoConnection(
  userId: string,
  projectId: string
): Promise<GithubRepoConnectionRecord | null> {
  const project = await findOwnedProjectRepo(userId, projectId);
  const ref = canonicalGithubRepoRef(project?.repoUrl);
  if (ref === null) return null;
  const connection = await findGithubRepoConnection(userId, ref);
  if (connection !== null) return connection;
  if ((await importLegacyProjectConnections(userId, [projectId])) === 0) return null;
  return findGithubRepoConnection(userId, ref);
}

/** Any ref spelling (canonical, URL, legacy project id) → the user's connection, or null. */
export async function resolveGithubRepoRef(
  userId: string,
  ref: string
): Promise<GithubRepoConnectionRecord | null> {
  const value = ref.trim();
  const projectId = value.startsWith(ROSE_PROJECT_REPO_PREFIX)
    ? value.slice(ROSE_PROJECT_REPO_PREFIX.length)
    : value;
  if (UUID.test(projectId)) return projectRepoConnection(userId, projectId);
  const identity = githubRepoIdentity(value);
  if (identity === null) return null;
  const connection = await findGithubRepoConnection(userId, identity.canonicalRef);
  if (connection !== null) return connection;
  // A repo still only on a project (connected through the legacy projects API).
  if ((await importLegacyProjectConnections(userId)) === 0) return null;
  return findGithubRepoConnection(userId, identity.canonicalRef);
}

/** Like resolveGithubRepoRef, but a ref the user cannot use is an error. */
export async function requireGithubRepoRef(
  userId: string,
  ref: string
): Promise<GithubRepoConnectionRecord> {
  const connection = await resolveGithubRepoRef(userId, ref);
  if (connection === null) throw new GithubRepoRefNotFoundError(ref);
  return connection;
}

export interface AgentRepoRefInput {
  /** Body `github_repo_ref`: undefined = not given, null = explicitly no repo. */
  explicitRef?: string | null;
  /** Trusted server-side root repository (CreateAgentOptions.githubRepoUrl). */
  serverRepoUrl?: string;
  /** Final placement; `explicitProject` when the body named the project or folder. */
  projectId: string | null;
  explicitProject: boolean;
  parent: { githubRepoRef: string | null; githubRepoUrl: string | null } | null;
}

export interface AgentRepoRefFields {
  githubRepoRef?: string;
  githubRepoUrl?: string;
}

/**
 * The repo ref a new agent persists (the fix for new agents losing their
 * project's repo). Project-derived refs leave githubRepoUrl alone: the project
 * restore owns those checkouts.
 */
export async function resolveAgentRepoRef(
  userId: string,
  input: AgentRepoRefInput,
  projectCache: Map<string, Promise<GithubRepoConnectionRecord | null>> = new Map()
): Promise<AgentRepoRefFields> {
  if (input.explicitRef === null) return {};
  if (input.explicitRef !== undefined) {
    const connection = await requireGithubRepoRef(userId, input.explicitRef);
    return { githubRepoRef: connection.canonicalRef, githubRepoUrl: connection.repoUrl };
  }
  if (input.serverRepoUrl !== undefined) {
    const ref = canonicalGithubRepoRef(input.serverRepoUrl);
    return { ...(ref !== null ? { githubRepoRef: ref } : {}), githubRepoUrl: input.serverRepoUrl };
  }
  const fromProject = async (): Promise<AgentRepoRefFields | null> => {
    if (input.projectId === null) return null;
    let pending = projectCache.get(input.projectId);
    if (pending === undefined) {
      pending = projectRepoConnection(userId, input.projectId);
      projectCache.set(input.projectId, pending);
    }
    const connection = await pending;
    return connection === null ? null : { githubRepoRef: connection.canonicalRef };
  };
  if (input.explicitProject) {
    const project = await fromProject();
    if (project !== null) return project;
  }
  const parentRef = input.parent?.githubRepoRef ?? null;
  if (parentRef !== null) {
    const parentUrl = input.parent?.githubRepoUrl ?? null;
    return {
      githubRepoRef: parentRef,
      ...(parentUrl !== null && sameGithubRepo(parentUrl, parentRef)
        ? { githubRepoUrl: parentUrl }
        : {}),
    };
  }
  return input.explicitProject ? {} : ((await fromProject()) ?? {});
}

export interface CodeSessionRepoInput {
  /** Spawn's explicit canonical ref (new `github_repo_ref` param). */
  githubRepoRef?: string;
  /** The agent's (or its root's) persisted ref. */
  agentRepoRef?: string | null;
  /** Project the session would restore. */
  projectId?: string;
  /** Legacy `github_repo_url` the spawn passed (used only when there is no project). */
  requestedRepoUrl?: string;
}

export interface CodeSessionRepoOverride {
  repoUrl: string;
  canonicalRef: string;
  /** True when the session's own project restore does not apply (different repo or none). */
  skipProject: boolean;
  /** Folder (Rose project) the repo is connected through; its settings restore instead. */
  repoProjectId: string | null;
}

/** The connection's folder, when that folder still carries the repo (its settings apply). */
async function connectedProjectId(
  userId: string,
  connection: GithubRepoConnectionRecord
): Promise<string | null> {
  const projectId = connection.connectedRoseProjectRef;
  if (projectId === null) return null;
  const project = await findOwnedProjectRepo(userId, projectId);
  return project !== null && sameGithubRepo(project.repoUrl, connection.repoUrl)
    ? project.id
    : null;
}

async function overrideFor(
  userId: string,
  connection: GithubRepoConnectionRecord,
  skipProject: boolean
): Promise<CodeSessionRepoOverride> {
  return {
    repoUrl: connection.repoUrl,
    canonicalRef: connection.canonicalRef,
    skipProject,
    repoProjectId: skipProject ? await connectedProjectId(userId, connection) : null,
  };
}

/**
 * A code session's repo from canonical refs: an explicit spawn ref, or an
 * agent ref that differs from its project's repo (an override persisted at
 * create), wins over the project restore. Without a project, the agent's ref
 * (or a legacy `github_repo_url`) that names a connected repo is used, so the
 * tree never falls back to a throwaway `agent-<id>` repo. Whenever the
 * session's own project is skipped, the folder the repo is connected through
 * (`repoProjectId`) restores instead, so its startup script, env files and
 * commands still apply. Legacy `github_repo_url` keeps its old rule when there
 * is a project (the project restore ignores it), so the agent prompts stay true.
 * Null: no override (legacy resolution runs unchanged).
 */
export async function resolveCodeSessionRepoOverride(
  userId: string | undefined,
  input: CodeSessionRepoInput
): Promise<CodeSessionRepoOverride | null> {
  const ref = input.githubRepoRef ?? '';
  const agentRef = input.agentRepoRef ?? null;
  const requestedUrl = input.requestedRepoUrl ?? '';
  const noProject = input.projectId === undefined || input.projectId === '';
  if (ref === '' && agentRef === null && (requestedUrl === '' || !noProject)) return null;
  if (userId === undefined || userId === '') {
    if (ref !== '') throw new GithubRepoRefNotFoundError(ref);
    return null;
  }
  const project = noProject ? null : await findOwnedProjectRepo(userId, input.projectId!);
  const projectRepoUrl = project?.repoUrl ?? null;
  if (ref !== '') {
    const connection = await requireGithubRepoRef(userId, ref);
    return overrideFor(userId, connection, !sameGithubRepo(connection.repoUrl, projectRepoUrl));
  }
  if (noProject) {
    // A legacy URL naming another repo keeps its old path; otherwise the agent's ref.
    const candidate =
      requestedUrl !== '' && (agentRef === null || !sameGithubRepo(requestedUrl, agentRef))
        ? requestedUrl
        : agentRef;
    if (candidate === null) return null;
    const connection = await resolveGithubRepoRef(userId, candidate);
    return connection === null ? null : overrideFor(userId, connection, true);
  }
  if (project === null || agentRef === null || sameGithubRepo(agentRef, projectRepoUrl))
    return null;
  // A disconnected override falls back to the legacy project / tree repo path.
  const connection = await resolveGithubRepoRef(userId, agentRef);
  return connection === null ? null : overrideFor(userId, connection, true);
}

/**
 * The project workspace a code session restores plus its canonical-ref repo
 * override. When the override replaces the session's project, the repo's own
 * connected folder restores (null when the repo has none).
 */
export async function resolveCodeSessionWorkspace(
  userId: string | undefined,
  input: CodeSessionRepoInput
): Promise<{ projectWorkspace: ProjectWorkspace | null; repoOverrideUrl: string | undefined }> {
  const override = await resolveCodeSessionRepoOverride(userId, input);
  const projectId =
    override?.skipProject === true ? (override.repoProjectId ?? undefined) : input.projectId;
  const projectWorkspace = await resolveSessionProject(userId, projectId);
  return { projectWorkspace, repoOverrideUrl: override?.repoUrl };
}
