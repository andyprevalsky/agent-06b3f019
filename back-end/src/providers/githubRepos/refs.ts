/**
 * Canonical connected-repo refs (pure; no I/O).
 *
 *   https://github.com/Rose-Ai-Labs/rose(.git)   ─┐
 *   github.com/Rose-Ai-Labs/rose                  ├─► gh:rose-ai-labs/rose
 *   Rose-Ai-Labs/rose  |  gh:Rose-Ai-Labs/rose   ─┘
 *
 * One stable ref per repository, independent of the connection row, so it
 * survives disconnect/reconnect and every legacy spelling (a project's repoUrl,
 * an agent's githubRepoUrl, a code session's repoUrl) resolves to the same value.
 * GitHub owner/repo names are case-insensitive, hence the lowercase ref.
 */
import { normalizeGithubUrl, parseGithubUrl } from '../github';

/** Integration `name` of a connected GitHub repo (one row per repo; accountId = canonical ref). */
export const GITHUB_REPO_INTEGRATION_NAME = 'github_repo';
export const GITHUB_REPO_REF_PREFIX = 'gh:';
/** Code sessions of a repo-less project use this repoUrl (claude-code/codex-code services). */
export const ROSE_PROJECT_REPO_PREFIX = 'rose-project:';

export interface GithubRepoIdentity {
  canonicalRef: string;
  /** Normalized https://github.com/<owner>/<repo>, case preserved. */
  repoUrl: string;
  owner: string;
  repoName: string;
}

export function isCanonicalGithubRepoRef(value: string): boolean {
  return /^gh:[^/\s]+\/[^/\s]+$/.test(value);
}

/** Identity of a GitHub URL, `owner/repo` or `gh:owner/repo`; null for anything else. */
export function githubRepoIdentity(value: string | null | undefined): GithubRepoIdentity | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  const raw = trimmed.startsWith(GITHUB_REPO_REF_PREFIX)
    ? trimmed.slice(GITHUB_REPO_REF_PREFIX.length)
    : trimmed;
  const repoUrl = normalizeGithubUrl(raw);
  const parsed = repoUrl === null ? null : parseGithubUrl(repoUrl);
  if (repoUrl === null || parsed === null) return null;
  // `owner/repo` pattern also matches scp-style remotes and local paths; reject them.
  if (!/^[A-Za-z0-9_.-]+$/.test(parsed.owner) || !/^[A-Za-z0-9_.-]+$/.test(parsed.repo)) {
    return null;
  }
  return {
    canonicalRef: `${GITHUB_REPO_REF_PREFIX}${parsed.owner}/${parsed.repo}`.toLowerCase(),
    repoUrl,
    owner: parsed.owner,
    repoName: parsed.repo,
  };
}

/**
 * `git@github.com:owner/repo(.git)` or `ssh://git@github.com/owner/repo(.git)`
 * (the SSH aliases projects/store projectRepositoryKey accepts) as
 * https://github.com/owner/repo, case kept; null for any other remote.
 */
export function githubHttpsUrlOfSshRemote(value: string): string | null {
  const match =
    /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      value.trim()
    );
  return match === null ? null : `https://github.com/${match[1]}/${match[2]}`;
}

/** Canonical ref of any GitHub spelling, or null. */
export function canonicalGithubRepoRef(value: string | null | undefined): string | null {
  return githubRepoIdentity(value)?.canonicalRef ?? null;
}

/** Same repository (case-insensitive), false when either side is not a GitHub repo. */
export function sameGithubRepo(a: string | null | undefined, b: string | null | undefined) {
  const left = canonicalGithubRepoRef(a);
  return left !== null && left === canonicalGithubRepoRef(b);
}
