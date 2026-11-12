/**
 * GitHub repo integration API (back-end/src/domains/integrations/routes.githubRepos.ts).
 *
 *   GET    /api/integrations/github/repos        -> { repos: GithubRepo[] } (includes repos
 *                                                  auto-imported from legacy project connections)
 *   POST   /api/integrations/github/repos        { repo_url, connected_rose_project_ref?, default_branch? }
 *                                                -> 201 GithubRepo
 *   DELETE /api/integrations/github/repos/:ref   -> { disconnected: true, canonical_ref }
 *
 * Errors answer `{ error: CODE, message }`: 400 INVALID_GITHUB_REPO | INVALID_BODY,
 * 403 GITHUB_ACCESS_DENIED, 404 PROJECT_NOT_FOUND | GITHUB_REPO_NOT_CONNECTED,
 * 409 PROJECT_HAS_OTHER_REPO, 503 GITHUB_RATE_LIMITED (+ Retry-After).
 */

import { getAuthHeaders } from '../api';
import { API_BASE_WITH_PATH } from '../config';

export interface GithubRepo {
  /** `gh:<owner>/<repo>`, lowercased. */
  canonical_ref: string;
  repo_name: string;
  repo_url: string;
  owner: string;
  default_branch: string;
  /** The folder (project id) the repo is connected to; null: none. */
  connected_rose_project_ref: string | null;
  integration_id: string;
  /** 'connect' (this panel) or 'legacy_project' (auto-imported, e.g. the Rose repo). */
  source: string;
  connected_at: string;
}

export interface ConnectGithubRepoInput {
  repo_url: string;
  connected_rose_project_ref?: string | null;
  default_branch?: string;
}

/** A refused GitHub repo request; `message` is the inline text the panel shows. */
export class GithubRepoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GithubRepoApiError';
  }
}

function retryHint(response: Response): string {
  const seconds = Number(response.headers.get('Retry-After'));
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Try again later.';
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** The inline message for each refusal the backend documents. */
function errorMessage(response: Response, code: string, detail: string | undefined): string {
  switch (code) {
    case 'GITHUB_ACCESS_DENIED':
      return 'Rose cannot access this repository. Install the Rose GitHub app on it (or make it public), then try again.';
    case 'PROJECT_HAS_OTHER_REPO':
      return 'That folder is already connected to a different repository. Choose another folder or none.';
    case 'PROJECT_NOT_FOUND':
      return 'That folder no longer exists. Choose another folder or none.';
    case 'INVALID_GITHUB_REPO':
    case 'INVALID_BODY':
      return 'Enter a GitHub repository URL, like https://github.com/owner/repo.';
    case 'GITHUB_REPO_NOT_CONNECTED':
      return 'This repository is not connected.';
    case 'GITHUB_RATE_LIMITED':
      return `GitHub is rate limiting requests. ${retryHint(response)}`;
    default:
      return detail ?? `GitHub repo request failed (${response.status})`;
  }
}

async function githubRepoJsonOrThrow<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as
    (T & { error?: string; message?: string }) | null;
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : '';
    throw new GithubRepoApiError(
      response.status,
      code,
      errorMessage(response, code, data?.message),
    );
  }
  return data as T;
}

const REPOS_URL = `${API_BASE_WITH_PATH}/integrations/github/repos`;

export async function fetchGithubReposApi(): Promise<GithubRepo[]> {
  const response = await fetch(REPOS_URL, { headers: getAuthHeaders() });
  return (await githubRepoJsonOrThrow<{ repos: GithubRepo[] }>(response)).repos;
}

export async function connectGithubRepoApi(input: ConnectGithubRepoInput): Promise<GithubRepo> {
  const response = await fetch(REPOS_URL, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(input),
  });
  return githubRepoJsonOrThrow<GithubRepo>(response);
}

export async function disconnectGithubRepoApi(canonicalRef: string): Promise<void> {
  const response = await fetch(`${REPOS_URL}/${encodeURIComponent(canonicalRef)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  await githubRepoJsonOrThrow<{ disconnected: true; canonical_ref: string }>(response);
}
