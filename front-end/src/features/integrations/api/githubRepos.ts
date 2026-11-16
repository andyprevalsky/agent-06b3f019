/**
 * GitHub repo connect (back-end/src/domains/integrations/routes.githubRepos.ts),
 * used by Integrations › Projects › GitHub repo: a connected repo IS a project
 * (the backend creates or links its project), so the panel refetches projects.
 *
 *   POST /api/integrations/github/repos  { repo_url } -> 201 GithubRepo
 *
 * Errors answer `{ error: CODE, message }`: 400 INVALID_GITHUB_REPO | INVALID_BODY,
 * 403 GITHUB_ACCESS_DENIED, 503 GITHUB_RATE_LIMITED (+ Retry-After).
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
  /** The project the repo belongs to. */
  connected_rose_project_ref: string | null;
  integration_id: string;
  /** 'connect' (this panel) or 'legacy_project' (auto-imported, e.g. the Rose repo). */
  source: string;
  connected_at: string;
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
      return "Rose can't reach this repository. Import it from your computer in the Rose Mac app, which brings your GitHub login.";
    case 'INVALID_GITHUB_REPO':
    case 'INVALID_BODY':
      return 'Enter a GitHub repository URL, like https://github.com/owner/repo.';
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

export async function connectGithubRepoApi(repoUrl: string): Promise<GithubRepo> {
  const response = await fetch(REPOS_URL, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ repo_url: repoUrl }),
  });
  return githubRepoJsonOrThrow<GithubRepo>(response);
}
