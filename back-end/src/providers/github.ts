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

/**
 * Check if a user has access to clone a specific GitHub repo.
 * Checks the GithubRepoAccess allowlist table.
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

  if (!access) {
    const parsed = parseGithubUrl(normalizedUrl);
    const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : normalizedUrl;
    return {
      allowed: false,
      normalizedUrl,
      error: `Access denied: You don't have permission to clone ${repoName}. Please contact support to request access.`,
    };
  }

  return { allowed: true, normalizedUrl };
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
