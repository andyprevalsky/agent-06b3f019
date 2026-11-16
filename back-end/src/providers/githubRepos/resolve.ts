/**
 * Resolve repo refs to the caller's active connections (server-side permission).
 *
 *   ref spelling                      resolves through
 *   gh:owner/repo | GitHub URL        the user's GithubRepoConnection (canonical ref)
 *   <project uuid> | rose-project:<id> the project's repoUrl → its connection (legacy)
 *
 * A canonical ref or URL the user has no own connection for falls back to a
 * repo a teammate shares with the user's team (shared.ts): the repository only,
 * never the owner's folder, and cloned under the owner's access grant. Any
 * other ref resolves to null: a foreign user's unshared repo, a disconnected
 * repo and a missing one are indistinguishable.
 *
 * A spawn's explicit project ref (resolveProjectRepoRef) selects EXACTLY that
 * owned project: its workspace restores (checkout, env files, startup script)
 * and its repo's connection applies when it has a GitHub repo; a project
 * without one (imported by `rose push`) restores from its synced bundle. A
 * project a team shares with the caller (projects/sharedProjects.ts) is
 * selectable too: its code and settings restore, never the owner's env files
 * or credentials. A GitHub repo with no connection yet is usable when the
 * caller can reach it themselves (their own GitHub credential, a grant, or a
 * public repo: checkGithubRepoAccess); otherwise the ref is refused.
 *
 * Agent creation (resolveAgentRepoRef) precedence, highest first:
 *   explicit `github_repo_ref` (null = explicitly none) > trusted server repo URL >
 *   explicit project placement's repo > parent agent's ref > inherited project's repo.
 */
import { checkGithubRepoAccess } from '../github';
import { resolveSessionProject } from '../projects/session';
import { findSharedProject } from '../projects/sharedProjects';
import type { ProjectWorkspace } from '../projects/types';
import {
  ROSE_PROJECT_REPO_PREFIX,
  canonicalGithubRepoRef,
  githubRepoIdentity,
  sameGithubRepo,
} from './refs';
import {
  ownGithubRepoConnection,
  sharedGithubRepoConnections,
  type UsableGithubRepoConnection,
} from './shared';
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

/** The project id a ref names (`<uuid>` or `rose-project:<uuid>`), else null. */
export function projectIdOfRepoRef(ref: string): string | null {
  const value = ref.trim();
  const projectId = value.startsWith(ROSE_PROJECT_REPO_PREFIX)
    ? value.slice(ROSE_PROJECT_REPO_PREFIX.length)
    : value;
  return UUID.test(projectId) ? projectId : null;
}

/** Connection of the GitHub repo an owned project carries; imports a legacy connection once. */
async function connectionOfProject(
  userId: string,
  project: { id: string; repoUrl: string | null }
): Promise<GithubRepoConnectionRecord | null> {
  const ref = canonicalGithubRepoRef(project.repoUrl);
  if (ref === null) return null;
  const connection = await findGithubRepoConnection(userId, ref);
  if (connection !== null) return connection;
  if ((await importLegacyProjectConnections(userId, [project.id])) === 0) return null;
  return findGithubRepoConnection(userId, ref);
}

/** Connection of the repo a project (folder) carries; imports a legacy connection once. */
export async function projectRepoConnection(
  userId: string,
  projectId: string
): Promise<GithubRepoConnectionRecord | null> {
  const project = await findOwnedProjectRepo(userId, projectId);
  return project === null ? null : connectionOfProject(userId, project);
}

export interface ProjectRepoRefSelection {
  projectId: string;
  /** The project's GitHub repo connection; null when the project has no GitHub repo. */
  connection: GithubRepoConnectionRecord | null;
}

/**
 * A ref naming a project selects exactly that project, owned or shared with
 * the caller (null: not a project ref). Its GitHub repo, when it has one, needs
 * the caller's connection or the caller's own access to it (no connection is
 * then returned: the session clones with that access); a project without a
 * GitHub repo needs neither. Otherwise, and for a missing or foreign project,
 * GithubRepoRefNotFoundError.
 */
export async function resolveProjectRepoRef(
  userId: string,
  ref: string
): Promise<ProjectRepoRefSelection | null> {
  const projectId = projectIdOfRepoRef(ref);
  if (projectId === null) return null;
  const owned = await findOwnedProjectRepo(userId, projectId);
  const project = owned ?? (await findSharedProject(userId, projectId));
  if (project === null) throw new GithubRepoRefNotFoundError(ref);
  const canonicalRef = canonicalGithubRepoRef(project.repoUrl);
  if (canonicalRef === null) return { projectId: project.id, connection: null };
  const connection =
    owned !== null
      ? await connectionOfProject(userId, owned)
      : await findGithubRepoConnection(userId, canonicalRef);
  if (connection !== null) return { projectId: project.id, connection };
  // No connection yet: the caller's own access (their GitHub credential, a grant, a public repo).
  const access = await checkGithubRepoAccess(userId, project.repoUrl!);
  if (!access.allowed) throw new GithubRepoRefNotFoundError(ref);
  const imported = owned !== null ? await connectionOfProject(userId, owned) : null;
  return { projectId: project.id, connection: imported };
}

/** Any ref spelling (canonical, URL, legacy project id) → the user's own connection, or null. */
export async function resolveOwnGithubRepoRef(
  userId: string,
  ref: string
): Promise<GithubRepoConnectionRecord | null> {
  const value = ref.trim();
  const projectId = projectIdOfRepoRef(value);
  if (projectId !== null) return projectRepoConnection(userId, projectId);
  const identity = githubRepoIdentity(value);
  if (identity === null) return null;
  const connection = await findGithubRepoConnection(userId, identity.canonicalRef);
  if (connection !== null) return connection;
  // A repo still only on a project (connected through the legacy projects API).
  if ((await importLegacyProjectConnections(userId)) === 0) return null;
  return findGithubRepoConnection(userId, identity.canonicalRef);
}

/** The user's own connection, else a teammate's shared one for a canonical ref or URL. */
export async function resolveGithubRepoRef(
  userId: string,
  ref: string
): Promise<UsableGithubRepoConnection | null> {
  const own = await resolveOwnGithubRepoRef(userId, ref);
  if (own !== null) return ownGithubRepoConnection(own);
  const canonicalRef = canonicalGithubRepoRef(ref);
  if (canonicalRef === null) return null;
  return (await sharedGithubRepoConnections(userId, canonicalRef))[0] ?? null;
}

/** Like resolveGithubRepoRef, but a ref the user cannot use is an error. */
export async function requireGithubRepoRef(
  userId: string,
  ref: string
): Promise<UsableGithubRepoConnection> {
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
    // A project ref is also the placement (agentProject.ts): the project restore owns the checkout.
    const selected = await resolveProjectRepoRef(userId, input.explicitRef);
    if (selected !== null) {
      return selected.connection === null
        ? {}
        : { githubRepoRef: selected.connection.canonicalRef };
    }
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
  /** Null: an explicit project ref whose project has no GitHub repo (its workspace restores). */
  repoUrl: string | null;
  canonicalRef: string | null;
  /** True when the session's own project restore does not apply (different repo or none). */
  skipProject: boolean;
  /** Folder (Rose project) the repo is connected through; its settings restore instead. */
  repoProjectId: string | null;
}

/**
 * The connection's folder, when that folder still carries the repo (its settings apply).
 * A teammate's shared repo never restores the owner's folder.
 */
async function connectedProjectId(
  userId: string,
  connection: UsableGithubRepoConnection
): Promise<string | null> {
  const projectId = connection.connectedRoseProjectRef;
  if (projectId === null || connection.shared !== null) return null;
  const project = await findOwnedProjectRepo(userId, projectId);
  return project !== null && sameGithubRepo(project.repoUrl, connection.repoUrl)
    ? project.id
    : null;
}

/** An override plus the user whose clone grant authorizes it (the owner of a shared repo). */
interface ResolvedRepoOverride {
  override: CodeSessionRepoOverride;
  accessUserId: string;
}

async function overrideFor(
  userId: string,
  connection: UsableGithubRepoConnection,
  skipProject: boolean
): Promise<ResolvedRepoOverride> {
  return {
    override: {
      repoUrl: connection.repoUrl,
      canonicalRef: connection.canonicalRef,
      skipProject,
      repoProjectId: skipProject ? await connectedProjectId(userId, connection) : null,
    },
    accessUserId: connection.userId,
  };
}

/** An explicit project ref: exactly that project restores, with its repo when it has one. */
function projectRefOverride(
  selected: ProjectRepoRefSelection,
  sessionProjectId: string | undefined
): CodeSessionRepoOverride {
  const skipProject = selected.projectId !== sessionProjectId;
  return {
    repoUrl: selected.connection?.repoUrl ?? null,
    canonicalRef: selected.connection?.canonicalRef ?? null,
    skipProject,
    repoProjectId: skipProject ? selected.projectId : null,
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
 * commands still apply. An explicit project ref restores exactly that project.
 * Legacy `github_repo_url` keeps its old rule when there
 * is a project (the project restore ignores it), so the agent prompts stay true.
 * A teammate's shared repo overrides like an own one, but never restores the
 * owner's folder. Null: no override (legacy resolution runs unchanged).
 */
export async function resolveCodeSessionRepoOverride(
  userId: string | undefined,
  input: CodeSessionRepoInput
): Promise<CodeSessionRepoOverride | null> {
  return (await resolveRepoOverride(userId, input))?.override ?? null;
}

async function resolveRepoOverride(
  userId: string | undefined,
  input: CodeSessionRepoInput
): Promise<ResolvedRepoOverride | null> {
  const ref = input.githubRepoRef ?? '';
  const agentRef = input.agentRepoRef ?? null;
  const requestedUrl = input.requestedRepoUrl ?? '';
  const noProject = input.projectId === undefined || input.projectId === '';
  if (ref === '' && agentRef === null && (requestedUrl === '' || !noProject)) return null;
  if (userId === undefined || userId === '') {
    if (ref !== '') throw new GithubRepoRefNotFoundError(ref);
    return null;
  }
  if (ref !== '') {
    const selected = await resolveProjectRepoRef(userId, ref);
    // A project ref clones with the caller's own access, never a sharer's grant.
    if (selected !== null) {
      return { override: projectRefOverride(selected, input.projectId), accessUserId: userId };
    }
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
 * connected folder restores (null when the repo has none or it is a teammate's);
 * an explicit project ref restores exactly that project (owned or team-shared,
 * cloned with the caller's own access). `repoAccessUserId` is whose clone grant
 * the override's repo is checked against: the caller for an own repo or a
 * project ref, the owner for an integration-shared repo. The session itself
 * (sandbox, credentials) always stays the caller's.
 */
export async function resolveCodeSessionWorkspace(
  userId: string | undefined,
  input: CodeSessionRepoInput
): Promise<{
  projectWorkspace: ProjectWorkspace | null;
  repoOverrideUrl: string | undefined;
  repoAccessUserId: string | undefined;
}> {
  const resolved = await resolveRepoOverride(userId, input);
  const override = resolved?.override;
  const projectId =
    override?.skipProject === true ? (override.repoProjectId ?? undefined) : input.projectId;
  const projectWorkspace = await resolveSessionProject(userId, projectId);
  return {
    projectWorkspace,
    repoOverrideUrl: override?.repoUrl ?? undefined,
    repoAccessUserId: resolved?.accessUserId,
  };
}

/** Whose clone grant authorizes `repoUrl`: a shared override's owner, else `userId` itself. */
export function repoAccessUserFor(
  workspace: { repoOverrideUrl: string | undefined; repoAccessUserId: string | undefined },
  repoUrl: string,
  userId: string
): string {
  return repoUrl === workspace.repoOverrideUrl ? (workspace.repoAccessUserId ?? userId) : userId;
}
