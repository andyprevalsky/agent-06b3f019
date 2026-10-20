/**
 * Resolve the Project a new code session should restore.
 *
 * GitHub clone credentials: the backend GITHUB_TOKEN is injected into the
 * clone URL only when the owner passes the same GithubRepoAccess check that
 * gates `github_repo_url` sessions, so a project's repoUrl cannot be used to
 * read repositories its owner was never granted.
 */
import { checkGithubRepoAccess } from '../github';
import { createLogger } from '../logger';
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
  const token = process.env.GITHUB_TOKEN;
  const access = await checkGithubRepoAccess(userId, repoUrl);
  if (!access.allowed || !access.normalizedUrl) {
    log.warn('Project repo not granted to owner; cloning without credentials', { userId });
    return repoUrl;
  }
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

export class ProjectNotFoundForSessionError extends Error {
  constructor() {
    super('Project not found');
  }
}

/** Session project for an owner (null = none); unknown/foreign ids throw. */
export async function resolveSessionProject(
  userId: string | undefined,
  projectId: string | undefined
): Promise<ProjectWorkspace | null> {
  if (projectId === undefined || projectId === '') return null;
  if (userId === undefined || userId === '') throw new ProjectNotFoundForSessionError();
  try {
    return await prepareSessionProject(userId, projectId);
  } catch (err) {
    if (err instanceof ProjectWorkspaceError) throw new ProjectNotFoundForSessionError();
    throw err;
  }
}
