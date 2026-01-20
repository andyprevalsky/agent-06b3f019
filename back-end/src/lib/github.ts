import { prisma } from './prisma';

/**
 * Normalize a GitHub URL to a consistent format.
 * Accepts: https://github.com/owner/repo, github.com/owner/repo, owner/repo, with optional .git suffix
 * @returns normalized URL (https://github.com/owner/repo) or null if invalid
 */
export function normalizeGithubUrl(url: string): string | null {
  const patterns = [
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)/,
    /^github\.com\/([^\/\s]+)\/([^\/\s]+)/,
    /^([^\/\s]+)\/([^\/\s]+)$/,
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

  const match = normalized.match(/github\.com\/([^\/]+)\/([^\/]+)/);
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
