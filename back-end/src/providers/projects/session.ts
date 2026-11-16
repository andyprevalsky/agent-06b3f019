/**
 * Resolve the Project a new code session should restore.
 *
 * GitHub clone credentials: a token is injected into the clone URL only when
 * the session's user passes the same GithubRepoAccess check that gates
 * `github_repo_url` sessions, so a project's repoUrl cannot be used to read
 * repositories that user was never granted. The token is the user's own
 * GitHub credential when it can push the repo (githubUserCredentials.ts),
 * else the backend GITHUB_TOKEN; never another user's.
 */
import { checkGithubRepoAccess, parseGithubUrl } from '../github';
import { userGithubSessionToken } from '../githubUserCredentials';
import { GithubRateLimitedError } from '../githubRateLimit';
import { createLogger } from '../logger';
import { prepareSharedProjectWorkspace } from './sharedProjects';
import { prepareProjectWorkspace, ProjectWorkspaceError } from './store';
import type { ProjectWorkspace } from './types';

const log = createLogger('ProjectSession');

function withGithubToken(normalizedUrl: string, token: string): string {
  const url = new URL(normalizedUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

async function resolveCloneUrl(userId: string, repoUrl: string | null): Promise<string | null> {
  if (!repoUrl) return null;
  let host = '';
  try {
    host = new URL(repoUrl).hostname;
  } catch {
    return repoUrl; // scp-style or local path: cloned as-is with the session's own credentials
  }
  if (host !== 'github.com') return repoUrl;
  const access = await checkGithubRepoAccess(userId, repoUrl);
  // A limit is not a denial: cloning without credentials would fail or, worse,
  // fall back to an empty checkout. Say so, with the reset time.
  if (access.rateLimit !== undefined) throw new GithubRateLimitedError(access.rateLimit);
  if (!access.allowed || !access.normalizedUrl) {
    log.warn('Project repo not granted to owner; cloning without credentials', { userId });
    return repoUrl;
  }
  const parsed = parseGithubUrl(access.normalizedUrl);
  const own =
    parsed === null ? null : await userGithubSessionToken(userId, parsed.owner, parsed.repo);
  if (own !== null) {
    log.info("Project clone uses the user's own GitHub credential", { userId, login: own.login });
  }
  const token = own?.token ?? process.env.GITHUB_TOKEN;
  return token ? withGithubToken(access.normalizedUrl, token) : access.normalizedUrl;
}

/** Decrypted workspace (+ clone URL) for `projectId`, owner-checked. */
export async function prepareSessionProject(
  userId: string,
  projectId: string
): Promise<ProjectWorkspace> {
  const workspace = await prepareProjectWorkspace(userId, projectId);
  const cloneUrl = await resolveCloneUrl(userId, workspace.project.repoUrl);
  return { ...workspace, cloneUrl };
}

/**
 * A project a team shares with `userId` (sharedProjects.ts): the owner's code
 * and settings, none of the owner's env files or credentials; the clone URL
 * carries the teammate's own access. Null when it is not shared with them.
 */
export async function prepareSharedSessionProject(
  userId: string,
  projectId: string
): Promise<ProjectWorkspace | null> {
  const workspace = await prepareSharedProjectWorkspace(userId, projectId);
  if (workspace === null) return null;
  log.info('Session restores a project shared with the user', { userId, projectId });
  return { ...workspace, cloneUrl: await resolveCloneUrl(userId, workspace.project.repoUrl) };
}

export class ProjectNotFoundForSessionError extends Error {
  constructor() {
    super('Project not found');
  }
}

/**
 * Session project for its owner, or for a teammate it is shared with (null =
 * none); unknown/foreign ids throw.
 */
export async function resolveSessionProject(
  userId: string | undefined,
  projectId: string | undefined
): Promise<ProjectWorkspace | null> {
  if (projectId === undefined || projectId === '') return null;
  if (userId === undefined || userId === '') throw new ProjectNotFoundForSessionError();
  try {
    return await prepareSessionProject(userId, projectId);
  } catch (err) {
    if (!(err instanceof ProjectWorkspaceError)) throw err;
  }
  const shared = await prepareSharedSessionProject(userId, projectId);
  if (shared === null) throw new ProjectNotFoundForSessionError();
  return shared;
}
