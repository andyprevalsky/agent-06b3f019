import { prisma } from './database';
import {
  activeGithubRateLimit,
  classifyGithubRateLimit,
  githubApiBase,
  githubFetch,
  GithubRateLimitedError,
  noteGithubRateLimit,
  resetGithubRateLimitStateForTests,
  type GithubRateLimitInfo,
} from './githubRateLimit';
import { githubPoolFetch } from './githubTokenPool';
import { userTokenRepoAccess } from './githubUserCredentials';
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

type GithubRepoVisibility = 'public' | 'private' | 'missing' | 'unknown' | 'rate_limited';

/**
 * Resolve whether a GitHub repo exists and is publicly cloneable.
 * Unauthenticated requests work for public repos; a configured token improves rate limits.
 * `rate_limited` means GitHub answered nothing about the repo; it is not `unknown`
 * (and never a denial): callers surface the limit.
 */
export async function fetchGithubRepoVisibility(
  owner: string,
  repo: string
): Promise<GithubRepoVisibility> {
  return (await lookupRepoVisibility(owner, repo)).visibility;
}

async function lookupRepoVisibility(
  owner: string,
  repo: string
): Promise<{ visibility: GithubRepoVisibility; rateLimit?: GithubRateLimitInfo }> {
  try {
    const response = await githubFetch(
      `${githubApiBase()}/repos/${owner}/${repo}`,
      { headers: githubApiAuthHeaders() },
      { component: 'GithubRepoVisibility', fetchImpl: githubPoolFetch() }
    );
    if (response.status === 404) return { visibility: 'missing' };
    if (!response.ok) {
      log.warn('GitHub repo visibility lookup failed', {
        owner,
        repo,
        status: response.status,
      });
      return { visibility: 'unknown' };
    }
    const data = (await response.json()) as { private?: boolean };
    return { visibility: data.private === true ? 'private' : 'public' };
  } catch (error) {
    if (error instanceof GithubRateLimitedError) {
      return { visibility: 'rate_limited', rateLimit: error.info };
    }
    log.warn('GitHub repo visibility lookup errored', {
      owner,
      repo,
      error: error instanceof Error ? error.message : String(error),
    });
    return { visibility: 'unknown' };
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
    // A change-watch poll: never wait for a limit, try again on the next tick.
    const response = await githubFetch(
      `${githubApiBase()}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      {
        headers: { ...githubApiAuthHeaders(), Accept: 'application/vnd.github.sha' },
        signal: AbortSignal.timeout(10_000),
      },
      { maxWaitMs: 0, component: 'GithubBranchHead', fetchImpl: githubPoolFetch() }
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
    if (error instanceof GithubRateLimitedError) {
      log.warn('GitHub branch head lookup rate limited', {
        owner,
        repo,
        branch,
        resetAt: error.resetAt,
      });
      return null;
    }
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
 * Checks the GithubRepoAccess allowlist table, then the user's own GitHub
 * credential (never stored as a grant: access follows the live credential, so
 * removing it takes effect at once), then auto-grants public repos.
 */
export async function checkGithubRepoAccess(
  userId: string,
  repoUrl: string
): Promise<{
  allowed: boolean;
  normalizedUrl: string | null;
  error?: string;
  /** Set when GitHub's rate limit, not a denial, stopped the check. */
  rateLimit?: GithubRateLimitInfo;
  /** How access was established: an existing grant, the user's own token, a public repo. */
  via?: 'grant' | 'user_token' | 'public';
}> {
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
    return { allowed: true, normalizedUrl, via: 'grant' };
  }

  const parsed = parseGithubUrl(normalizedUrl);
  const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : normalizedUrl;
  if (parsed) {
    // The user's own GitHub credential first: a repo it can push is theirs to use.
    const own = await userTokenRepoAccess(userId, parsed.owner, parsed.repo);
    if (own?.canPush === true) {
      log.info("Allowed GitHub repo access through the user's own credential", {
        userId,
        repoUrl: normalizedUrl,
        login: own.login,
      });
      return { allowed: true, normalizedUrl, via: 'user_token' };
    }
    const { visibility, rateLimit } = await lookupRepoVisibility(parsed.owner, parsed.repo);
    if (rateLimit !== undefined) {
      return {
        allowed: false,
        normalizedUrl,
        rateLimit,
        error: new GithubRateLimitedError(rateLimit).message,
      };
    }
    if (visibility === 'public') {
      await grantGithubRepoAccess(userId, normalizedUrl);
      log.info('Auto-granted public GitHub repo access', {
        userId,
        repoUrl: normalizedUrl,
      });
      return { allowed: true, normalizedUrl, via: 'public' };
    }
    if (visibility === 'private') {
      return {
        allowed: false,
        normalizedUrl,
        error: `Access denied: Rose can't reach the private repository ${repoName}. Import it from your computer in the Rose Mac app, which brings your GitHub login.`,
      };
    }
  }

  return {
    allowed: false,
    normalizedUrl,
    error: `Access denied: Rose can't reach ${repoName}. Import it from your computer in the Rose Mac app, which brings your GitHub login.`,
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
const repoCreateState = {
  nextSlotAt: 0,
  login: null as string | null,
};

/** Test hook: reset the pacer and the process-wide GitHub rate-limit block between cases. */
export function resetGithubRepoCreateStateForTests(): void {
  repoCreateState.nextSlotAt = 0;
  repoCreateState.login = null;
  resetGithubRateLimitStateForTests();
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

/** The existing repo's URL when a create reports the name is taken (a retry or a race). */
async function existingRepoUrl(token: string, repoName: string): Promise<string | null> {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  if (repoCreateState.login === null) {
    const me = await githubFetch(`${githubApiBase()}/user`, { headers }, { maxWaitMs: 0 });
    if (!me.ok) return null;
    repoCreateState.login = ((await me.json()) as { login: string }).login;
  }
  const response = await githubFetch(
    `${githubApiBase()}/repos/${repoCreateState.login}/${repoName}`,
    { headers },
    { maxWaitMs: 0 }
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
  const blocked = activeGithubRateLimit();
  if (blocked !== null) {
    log.warn('GitHub repo creation blocked by a rate limit', {
      repoName,
      retryInMs: blocked.resetAtMs - Date.now(),
      resetAt: new Date(blocked.resetAtMs).toISOString(),
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
      const response = await fetch(`${githubApiBase()}/user/repos`, {
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
      const limit = classifyGithubRateLimit(response.status, response.headers, lastBody);
      if (limit !== null) {
        noteGithubRateLimit(limit);
        log.error('GitHub repo creation rate limited; pausing all GitHub calls', {
          repoName,
          status: response.status,
          kind: limit.kind,
          resetAt: new Date(limit.resetAtMs).toISOString(),
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
