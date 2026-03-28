import { prisma } from './database';

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

/**
 * Create a fresh public GitHub repo under the rose-gh-agent account.
 * Uses GITHUB_TOKEN (PAT with repo scope).
 *
 * @param repoName - The repo name (e.g., "agent-a1b2c3d4")
 * @returns The HTTPS URL of the created repo, or null on failure
 */
export async function createGithubRepo(repoName: string): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[GitHub] GITHUB_TOKEN not configured — cannot create repo');
    return null;
  }

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

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[GitHub] Failed to create repo ${repoName}: HTTP ${response.status}`,
        errorBody
      );
      return null;
    }

    const data = (await response.json()) as { html_url: string };
    const repoUrl = data.html_url;
    console.log(`[GitHub] Created repo: ${repoUrl}`);
    return repoUrl;
  } catch (error) {
    console.error(`[GitHub] Error creating repo ${repoName}:`, error);
    return null;
  }
}
