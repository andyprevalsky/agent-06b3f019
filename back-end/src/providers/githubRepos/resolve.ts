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
}

/**
 * A code session's repo from canonical refs: an explicit spawn ref, or an
 * agent ref that differs from its project's repo (an override persisted at
 * create), wins over the project restore. Legacy `github_repo_url` keeps its
 * old rule (the project restore ignores it), so the agent prompts stay true.
 * Null: no override (legacy resolution runs unchanged).
 */
export async function resolveCodeSessionRepoOverride(
  userId: string | undefined,
  input: CodeSessionRepoInput
): Promise<{ repoUrl: string; canonicalRef: string; skipProject: boolean } | null> {
  const ref = input.githubRepoRef ?? '';
  const agentRef = input.agentRepoRef ?? null;
  if (ref === '' && (agentRef === null || input.projectId === undefined)) return null;
  if (userId === undefined || userId === '') {
    if (ref !== '') throw new GithubRepoRefNotFoundError(ref);
    return null;
  }
  const project =
    input.projectId !== undefined ? await findOwnedProjectRepo(userId, input.projectId) : null;
  const projectRepoUrl = project?.repoUrl ?? null;
  if (ref !== '') {
    const connection = await requireGithubRepoRef(userId, ref);
    return {
      repoUrl: connection.repoUrl,
      canonicalRef: connection.canonicalRef,
      skipProject: !sameGithubRepo(connection.repoUrl, projectRepoUrl),
    };
  }
  if (project === null || agentRef === null || sameGithubRepo(agentRef, projectRepoUrl))
    return null;
  // A disconnected override falls back to the legacy project / tree repo path.
  const connection = await resolveGithubRepoRef(userId, agentRef);
  return connection === null
    ? null
    : { repoUrl: connection.repoUrl, canonicalRef: connection.canonicalRef, skipProject: true };
}

/**
 * The project workspace a code session restores plus its canonical-ref repo
 * override (null workspace when the override replaces the project).
 */
export async function resolveCodeSessionWorkspace(
  userId: string | undefined,
  input: CodeSessionRepoInput
): Promise<{ projectWorkspace: ProjectWorkspace | null; repoOverrideUrl: string | undefined }> {
  const override = await resolveCodeSessionRepoOverride(userId, input);
  const projectWorkspace =
    override?.skipProject === true ? null : await resolveSessionProject(userId, input.projectId);
  return { projectWorkspace, repoOverrideUrl: override?.repoUrl };
}
