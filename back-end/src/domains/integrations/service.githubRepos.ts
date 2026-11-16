/**
 * GitHub repo integration ("github_repo"): connect / disconnect / inventory /
 * resolve, built on the project repo logic it replaces (providers/githubRepos,
 * checkGithubRepoAccess). Folders no longer carry the connection; a repo
 * connected through one records it as connected_rose_project_ref.
 *
 *   connect(repo_url, connected_rose_project_ref?, replace?)
 *     ─► checkGithubRepoAccess (grant, or public auto-grant)   403 / 429 otherwise
 *     ─► owned project check                                    404 / 409
 *     ─► Integration + GithubRepoConnection (one transaction)
 *     ─► repo-less project now points at the repo (legacy code-session restore)
 *
 * Every read is owner-scoped; a repo is listed only while it is connected AND
 * the user still holds its clone grant. The agent inventory (and any caller
 * passing include_shared) also lists repos teammates share with the user's
 * teams, marked `shared` with their owner and never carrying the owner's
 * folder; resolve accepts them too, disconnect never (it is owner-only).
 */
import { checkGithubRepoAccess } from '../../providers/github';
import { createLogger } from '../../providers/logger';
import { githubRepoIdentity, sameGithubRepo } from '../../providers/githubRepos/refs';
import { resolveGithubRepoRef, resolveOwnGithubRepoRef } from '../../providers/githubRepos/resolve';
import {
  sharedGithubRepoConnections,
  type UsableGithubRepoConnection,
} from '../../providers/githubRepos/shared';
import {
  connectGithubRepo as writeConnection,
  disconnectGithubRepo as removeConnection,
  findGithubRepoConnection,
  findGrantedRepoUrls,
  findOwnedProjectRepo,
  importLegacyProjectConnections,
  listGithubRepoConnections,
  repointProjectRepo,
  setProjectRepoUrlIfEmpty,
  type GithubRepoConnectionRecord,
} from '../../providers/githubRepos/store';

const log = createLogger('GithubRepoIntegration');

export class GithubRepoIntegrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS?: number
  ) {
    super(message);
    this.name = 'GithubRepoIntegrationError';
  }
}

export interface GithubRepoDto {
  canonical_ref: string;
  repo_name: string;
  repo_url: string;
  owner: string;
  default_branch: string;
  connected_rose_project_ref: string | null;
  integration_id: string;
  source: string;
  connected_at: string;
  /** Present only on a teammate's repo shared with one of the caller's teams. */
  shared?: { team_id: string; team_name: string; owner_user_id: string; owner_name: string | null };
}

export function toGithubRepoDto(
  row: GithubRepoConnectionRecord | UsableGithubRepoConnection
): GithubRepoDto {
  const shared = 'shared' in row ? row.shared : null;
  return {
    canonical_ref: row.canonicalRef,
    repo_name: row.repoName,
    repo_url: row.repoUrl,
    owner: row.owner,
    default_branch: row.defaultBranch,
    connected_rose_project_ref: shared === null ? row.connectedRoseProjectRef : null,
    integration_id: row.integrationId,
    source: row.source,
    connected_at: row.createdAt.toISOString(),
    ...(shared !== null
      ? {
          shared: {
            team_id: shared.teamId,
            team_name: shared.teamName,
            owner_user_id: shared.ownerUserId,
            owner_name: shared.ownerName,
          },
        }
      : {}),
  };
}

/**
 * Deduplicated accessible-repo inventory (legacy project repos imported first);
 * with `includeShared`, then the repos teammates share that the user has no own
 * connection for.
 */
export async function listGithubRepos(
  userId: string,
  options: { includeShared?: boolean } = {}
): Promise<{ repos: GithubRepoDto[] }> {
  try {
    await importLegacyProjectConnections(userId);
  } catch (error) {
    // The inventory never depends on the import; the next read retries it.
    log.error('Legacy project repo import failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const rows = await listGithubRepoConnections(userId);
  const granted = await findGrantedRepoUrls(
    userId,
    rows.map((row) => row.repoUrl)
  );
  const own = rows.filter((row) => granted.has(row.repoUrl));
  if (options.includeShared !== true) return { repos: own.map((row) => toGithubRepoDto(row)) };
  const ownRefs = new Set(rows.map((row) => row.canonicalRef));
  const shared = (await sharedGithubRepoConnections(userId)).filter(
    (row) => !ownRefs.has(row.canonicalRef)
  );
  return { repos: [...own, ...shared].map((row) => toGithubRepoDto(row)) };
}

export interface ConnectGithubRepoInput {
  repo_url: string;
  connected_rose_project_ref?: string | null;
  default_branch?: string;
  /** Re-point the folder at this repo even when it has another one (else 409). */
  replace?: boolean;
}

async function assertCloneAccess(userId: string, repoUrl: string): Promise<void> {
  const access = await checkGithubRepoAccess(userId, repoUrl);
  if (access.rateLimit !== undefined) {
    throw new GithubRepoIntegrationError(
      503,
      'GITHUB_RATE_LIMITED',
      access.error ?? 'GitHub rate limit reached',
      Math.max(1, Math.ceil((access.rateLimit.resetAtMs - Date.now()) / 1000))
    );
  }
  if (!access.allowed) {
    throw new GithubRepoIntegrationError(
      403,
      'GITHUB_ACCESS_DENIED',
      access.error ?? 'Access denied'
    );
  }
}

export async function connectGithubRepo(
  userId: string,
  input: ConnectGithubRepoInput
): Promise<GithubRepoDto> {
  const requested = githubRepoIdentity(input.repo_url);
  if (requested === null) {
    throw new GithubRepoIntegrationError(400, 'INVALID_GITHUB_REPO', 'Not a GitHub repository');
  }
  // Grants are keyed by the exact URL: a reconnect in another casing reuses the stored spelling.
  const existing = await findGithubRepoConnection(userId, requested.canonicalRef);
  const identity =
    existing === null
      ? requested
      : {
          ...requested,
          repoUrl: existing.repoUrl,
          owner: existing.owner,
          repoName: existing.repoName,
        };
  const projectRef = input.connected_rose_project_ref ?? null;
  const project = projectRef === null ? null : await findOwnedProjectRepo(userId, projectRef);
  if (projectRef !== null && project === null) {
    throw new GithubRepoIntegrationError(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
  if (
    input.replace !== true &&
    project !== null &&
    project.repoUrl !== null &&
    !sameGithubRepo(project.repoUrl, identity.repoUrl)
  ) {
    throw new GithubRepoIntegrationError(
      409,
      'PROJECT_HAS_OTHER_REPO',
      'This project is already connected to a different repository'
    );
  }
  await assertCloneAccess(userId, identity.repoUrl);
  const write = {
    userId,
    identity,
    defaultBranch:
      input.default_branch ?? existing?.defaultBranch ?? project?.defaultBranch ?? 'main',
    source: existing?.source === 'legacy_project' ? 'legacy_project' : 'connect',
  } as const;
  if (input.replace === true && project !== null) {
    // Switch repo: the folder's old repo stays connected, unassociated (store helper).
    const connection = await repointProjectRepo({ ...write, connectedRoseProjectRef: project.id });
    log.info('GitHub repo re-pointed', { userId, canonicalRef: identity.canonicalRef });
    return toGithubRepoDto(connection);
  }
  const connection = await writeConnection({
    ...write,
    connectedRoseProjectRef: project?.id ?? null,
  });
  if (project !== null && project.repoUrl === null) {
    await setProjectRepoUrlIfEmpty(userId, project.id, identity.repoUrl);
  }
  log.info('GitHub repo connected', { userId, canonicalRef: identity.canonicalRef });
  return toGithubRepoDto(connection);
}

export async function disconnectGithubRepo(
  userId: string,
  ref: string
): Promise<{ disconnected: true; canonical_ref: string }> {
  const connection = await resolveOwnGithubRepoRef(userId, ref);
  if (connection === null || !(await removeConnection(userId, connection.canonicalRef))) {
    throw new GithubRepoIntegrationError(404, 'GITHUB_REPO_NOT_CONNECTED', 'Repo not connected');
  }
  log.info('GitHub repo disconnected', { userId, canonicalRef: connection.canonicalRef });
  return { disconnected: true, canonical_ref: connection.canonicalRef };
}

/** Legacy spellings (project id, rose-project:<id>, repo URL) → the canonical connection (own or shared). */
export async function resolveGithubRepo(userId: string, ref: string): Promise<GithubRepoDto> {
  const connection = await resolveGithubRepoRef(userId, ref);
  if (connection === null) {
    throw new GithubRepoIntegrationError(404, 'GITHUB_REPO_NOT_CONNECTED', 'Repo not connected');
  }
  return toGithubRepoDto(connection);
}
