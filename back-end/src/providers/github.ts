import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('GitHub');

/**
 * Normalize a GitHub URL to a consistent format.
 * Accepts: https://github.com/owner/repo, github.com/owner/repo, owner/repo, with optional .git suffix
 * @returns normalized URL (https://github.com/owner/repo) or null if invalid
 */
export function normalizeGithubUrl(url: string): string | null {
  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)/,
    /^github\.com\/([^/\s]+)\/([^/\s]+)/,
    /^([^/\s]+)\/([^/\s]+)$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const [, owner, repo] = match;
      // Remove .git suffix if present
      const cleanRepo = repo.replace(/\.git$/, '');
      return `https://github.com/${owner}/${cleanRepo}`;
    }
  }
  return null;
}

/**
 * Extract owner and repo name from a GitHub URL.
 */
export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const normalized = normalizeGithubUrl(url);
  if (!normalized) return null;

  const match = normalized.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;

  return { owner: match[1], repo: match[2] };
}

function githubApiAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  const token = [process.env.GITHUB_TOKEN ?? '', process.env.GITHUB_DISPATCH_TOKEN ?? '']
    .map((value) => value.trim())
    .find((value) => value !== '');
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

type GithubRepoVisibility = 'public' | 'private' | 'missing' | 'unknown';

/**
 * Resolve whether a GitHub repo exists and is publicly cloneable.
 * Unauthenticated requests work for public repos; a configured token improves rate limits.
 */
export async function fetchGithubRepoVisibility(
  owner: string,
  repo: string
): Promise<GithubRepoVisibility> {
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: githubApiAuthHeaders(),
    });
    if (response.status === 404) return 'missing';
    if (!response.ok) {
      log.warn('GitHub repo visibility lookup failed', {
        owner,
        repo,
        status: response.status,
      });
      return 'unknown';
    }
    const data = (await response.json()) as { private?: boolean };
    return data.private === true ? 'private' : 'public';
  } catch (error) {
    log.warn('GitHub repo visibility lookup errored', {
      owner,
      repo,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}

/**
 * Head commit sha of a branch (one authenticated GitHub API read), or null
 * when the branch or repo is missing or GitHub could not be reached. Used by
 * the project template sync to notice that a default branch moved.
 */
export async function fetchGithubBranchHeadSha(
  owner: string,
  repo: string,
  branch: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      { headers: { ...githubApiAuthHeaders(), Accept: 'application/vnd.github.sha' } }
    );
    if (!response.ok) {
      log.warn('GitHub branch head lookup failed', {
        owner,
        repo,
        branch,
        status: response.status,
      });
      return null;
    }
    const sha = (await response.text()).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (error) {
    log.warn('GitHub branch head lookup errored', {
      owner,
      repo,
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function grantGithubRepoAccess(userId: string, repoUrl: string): Promise<void> {
  try {
    await prisma.githubRepoAccess.create({
      data: { userId, repoUrl },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Unique constraint')) {
      throw error;
    }
  }
}

/**
 * Check if a user has access to clone a specific GitHub repo.
 * Checks the GithubRepoAccess allowlist table, then auto-grants public repos.
 */
export async function checkGithubRepoAccess(
  userId: string,
  repoUrl: string
): Promise<{ allowed: boolean; normalizedUrl: string | null; error?: string }> {
  const normalizedUrl = normalizeGithubUrl(repoUrl);

  if (!normalizedUrl) {
    return {
      allowed: false,
      normalizedUrl: null,
      error: `Invalid GitHub URL format: ${repoUrl}`,
    };
  }

  const access = await prisma.githubRepoAccess.findUnique({
    where: {
      userId_repoUrl: {
        userId,
        repoUrl: normalizedUrl,
      },
    },
  });

  if (access) {
    return { allowed: true, normalizedUrl };
  }

  const parsed = parseGithubUrl(normalizedUrl);
  const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : normalizedUrl;
  if (parsed) {
    const visibility = await fetchGithubRepoVisibility(parsed.owner, parsed.repo);
    if (visibility === 'public') {
      await grantGithubRepoAccess(userId, normalizedUrl);
      log.info('Auto-granted public GitHub repo access', {
        userId,
        repoUrl: normalizedUrl,
      });
      return { allowed: true, normalizedUrl };
    }
    if (visibility === 'private') {
      return {
        allowed: false,
        normalizedUrl,
        error: `Access denied: ${repoName} is private. Please contact support to request access.`,
      };
    }
  }

  return {
    allowed: false,
    normalizedUrl,
    error: `Access denied: You don't have permission to clone ${repoName}. Please contact support to request access.`,
  };
}

/**
 * Create a fresh public GitHub repo under the rose-gh-agent account.
 * Prefers GITHUB_TOKEN, then falls back to GITHUB_DISPATCH_TOKEN when the
 * primary PAT is present but rejected (401/403) — same pattern as admin-health
 * velocity commits.
 *
 * @param repoName - The repo name (e.g., "agent-a1b2c3d4")
 * @returns The HTTPS URL of the created repo, or null on failure
 */
export async function createGithubRepo(repoName: string): Promise<string | null> {
  const candidates = [process.env.GITHUB_TOKEN ?? '', process.env.GITHUB_DISPATCH_TOKEN ?? '']
    .map((token) => token.trim())
    .filter((token) => token !== '');
  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    log.error('GITHUB_TOKEN not configured — cannot create repo');
    return null;
  }

  let lastStatus: number | null = null;
  let lastBody = '';
  for (let index = 0; index < unique.length; index += 1) {
    const token = unique[index];
    try {
      const response = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          name: repoName,
          description: 'Auto-created workspace for Rose Labs agent',
          private: false,
          auto_init: true,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as { html_url: string };
        const repoUrl = data.html_url;
        log.info('Created repo', { repoUrl });
        return repoUrl;
      }

      lastStatus = response.status;
      lastBody = await response.text();
      const hasFallback =
        index < unique.length - 1 && (response.status === 401 || response.status === 403);
      if (hasFallback) {
        log.warn('GitHub token rejected for create repo; trying fallback', {
          repoName,
          status: response.status,
        });
        continue;
      }
      log.error('Failed to create repo', {
        repoName,
        status: response.status,
        errorBody: lastBody,
      });
      return null;
    } catch (error) {
      log.error('Error creating repo', {
        repoName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  log.error('Failed to create repo', {
    repoName,
    status: lastStatus,
    errorBody: lastBody,
  });
  return null;
}
