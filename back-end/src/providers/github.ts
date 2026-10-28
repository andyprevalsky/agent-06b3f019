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

// ── Agent workspace repos ───────────────────────────────────────────────────
//
// Every agent repo is created by one token, so every caller shares GitHub's
// secondary content-creation limit (~80/min, ~500/h per account). On 2026-10-28
// local, benchmark and devbox stacks running with the production token made 96%
// of the creates; the account was blocked and production users' code agents got
// no repo for hours. So:
//   - only production (Render) creates repos unless GITHUB_AGENT_REPOS=on;
//   - a repo is created when a tree first starts a code session, not per chat;
//   - one process-wide pacer spaces creates, and a secondary-limit response
//     blocks all creates until its Retry-After instead of hammering the limit.
// No per-user cap: the pacer is global and first-come.

/** Spacing between creates: 480/h, under GitHub's ~500/h content-creation limit. */
const REPO_CREATE_MIN_INTERVAL_MS = Number(process.env.GITHUB_REPO_CREATE_MIN_INTERVAL_MS ?? 7_500);
/** A create that cannot start within this wait is skipped; the session runs repo-less. */
const REPO_CREATE_MAX_QUEUE_WAIT_MS = Number(process.env.GITHUB_REPO_CREATE_MAX_WAIT_MS ?? 20_000);
/** GitHub asks for at least a minute when a secondary limit carries no Retry-After. */
const SECONDARY_LIMIT_DEFAULT_BLOCK_MS = 60_000;

const repoCreateState = {
  nextSlotAt: 0,
  blockedUntil: 0,
  login: null as string | null,
};

/** Test hook: reset the pacer and block between cases. */
export function resetGithubRepoCreateStateForTests(): void {
  repoCreateState.nextSlotAt = 0;
  repoCreateState.blockedUntil = 0;
  repoCreateState.login = null;
}

/** Agent repos are created only by production unless explicitly enabled. */
export function agentRepoCreationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.GITHUB_AGENT_REPOS ?? '').trim().toLowerCase();
  if (flag === 'on' || flag === 'true') return true;
  if (flag === 'off' || flag === 'false') return false;
  return env.RENDER === 'true';
}

/** Reserve the next create slot; false when it would wait longer than allowed. */
async function reserveRepoCreateSlot(): Promise<boolean> {
  const now = Date.now();
  const slot = Math.max(now, repoCreateState.nextSlotAt);
  if (slot - now > REPO_CREATE_MAX_QUEUE_WAIT_MS) return false;
  repoCreateState.nextSlotAt = slot + REPO_CREATE_MIN_INTERVAL_MS;
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  return true;
}

function isRateLimited(status: number, body: string): boolean {
  return (status === 403 || status === 429) && /rate limit/i.test(body);
}

function retryAfterMs(headers: Headers): number {
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0)
    return Math.max(0, reset * 1000 - Date.now());
  return SECONDARY_LIMIT_DEFAULT_BLOCK_MS;
}

/** The existing repo's URL when a create reports the name is taken (a retry or a race). */
async function existingRepoUrl(token: string, repoName: string): Promise<string | null> {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  if (repoCreateState.login === null) {
    const me = await fetch('https://api.github.com/user', { headers });
    if (!me.ok) return null;
    repoCreateState.login = ((await me.json()) as { login: string }).login;
  }
  const response = await fetch(
    `https://api.github.com/repos/${repoCreateState.login}/${repoName}`,
    { headers }
  );
  return response.ok ? ((await response.json()) as { html_url: string }).html_url : null;
}

/**
 * Create a fresh public GitHub repo under the agent repo account.
 * Prefers GITHUB_TOKEN, then falls back to GITHUB_DISPATCH_TOKEN when the
 * primary PAT is present but rejected (401/403) — same pattern as admin-health
 * velocity commits. Paced and blocked as described above; an existing repo of
 * the same name is returned, so the call is idempotent.
 *
 * @param repoName - The repo name (e.g., "agent-a1b2c3d4")
 * @returns The HTTPS URL of the created repo, or null on failure, while
 *   blocked, when the pacer queue is full, or when creation is disabled
 */
export async function createGithubRepo(repoName: string): Promise<string | null> {
  if (!agentRepoCreationEnabled()) {
    log.info('Agent repo creation disabled outside production', { repoName });
    return null;
  }
  const candidates = [process.env.GITHUB_TOKEN ?? '', process.env.GITHUB_DISPATCH_TOKEN ?? '']
    .map((token) => token.trim())
    .filter((token) => token !== '');
  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    log.error('GITHUB_TOKEN not configured — cannot create repo');
    return null;
  }
  if (Date.now() < repoCreateState.blockedUntil) {
    log.warn('GitHub repo creation blocked by a secondary rate limit', {
      repoName,
      retryInMs: repoCreateState.blockedUntil - Date.now(),
    });
    return null;
  }
  if (!(await reserveRepoCreateSlot())) {
    log.warn('GitHub repo creation queue is full; continuing without a repo', { repoName });
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
      if (isRateLimited(response.status, lastBody)) {
        const waitMs = retryAfterMs(response.headers);
        repoCreateState.blockedUntil = Date.now() + waitMs;
        log.error('GitHub repo creation rate limited; pausing all creates', {
          repoName,
          status: response.status,
          retryInMs: waitMs,
        });
        return null;
      }
      if (response.status === 422 && /already exists/i.test(lastBody)) {
        const existing = await existingRepoUrl(token, repoName);
        if (existing !== null) {
          log.info('Reusing existing repo', { repoUrl: existing });
          return existing;
        }
      }
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

const inFlightTreeRepos = new Map<string, Promise<string | undefined>>();

/**
 * The agent tree's workspace repo, created on first need (a code session).
 * Idempotent: an existing URL is returned, concurrent callers in a process
 * share one create, and a conditional write keeps the first URL if two
 * processes race (the deterministic name makes GitHub return the same repo).
 * Trees bound to a project return undefined: the project owns the checkout.
 */
export async function ensureAgentTreeRepo(agentId: string): Promise<string | undefined> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { busId: true },
  });
  if (!agent) return undefined;
  const rootId = agent.busId !== null && agent.busId !== '' ? agent.busId : agentId;
  const pending = inFlightTreeRepos.get(rootId);
  if (pending) return pending;
  const work = (async () => {
    const root = await prisma.agent.findUnique({
      where: { id: rootId },
      select: { githubRepoUrl: true, userId: true, projectId: true },
    });
    if (!root || root.projectId !== null) return undefined;
    if (root.githubRepoUrl !== null) return root.githubRepoUrl;
    const created = await createGithubRepo(`agent-${rootId.substring(0, 8)}`);
    if (created === null) return undefined;
    await prisma.agent.updateMany({
      where: { id: rootId, githubRepoUrl: null },
      data: { githubRepoUrl: created },
    });
    const winner = await prisma.agent.findUnique({
      where: { id: rootId },
      select: { githubRepoUrl: true },
    });
    const repoUrl = winner?.githubRepoUrl ?? created;
    if (root.userId !== null) await grantGithubRepoAccess(root.userId, repoUrl);
    return repoUrl;
  })().finally(() => inFlightTreeRepos.delete(rootId));
  inFlightTreeRepos.set(rootId, work);
  return work;
}
