/**
 * GitHub token pool.
 *
 * Members: GITHUB_TOKEN (the primary identity) then GITHUB_TOKEN_2 … GITHUB_TOKEN_9
 * (machine accounts), with GITHUB_DISPATCH_TOKEN kept as the last-resort member
 * for auth fallbacks. Each GitHub user has its own 5,000/h core quota, so reads
 * spread across members instead of draining the primary account.
 *
 *   caller ──githubFetch(url, init, { identity })──▶ pickGithubToken
 *                                                     │  pool: most remaining quota
 *                                                     │  primary: GITHUB_TOKEN only
 *                                                     ▼
 *                                                GitHub API ──x-ratelimit-* headers──▶ recordGithubResponse
 *                                                     │ 401 or rate limited
 *                                                     └──▶ retried once per remaining member (pool only)
 *
 * Writes that act as the token's own account (creating repos under /user,
 * pushing to the primary owner's personal repos, opening PRs as that user)
 * must keep `identity: 'primary'`. State is per process and derived only from
 * GitHub's own response headers: O(members) per call, no shared lock.
 */
import { createLogger } from './logger';

const log = createLogger('GitHubTokenPool');

const POOL_KEYS = [
  'GITHUB_TOKEN',
  'GITHUB_TOKEN_2',
  'GITHUB_TOKEN_3',
  'GITHUB_TOKEN_4',
  'GITHUB_TOKEN_5',
  'GITHUB_TOKEN_6',
  'GITHUB_TOKEN_7',
  'GITHUB_TOKEN_8',
  'GITHUB_TOKEN_9',
  'GITHUB_DISPATCH_TOKEN',
] as const;

/** A member that returned 401 is skipped for this long before being retried. */
const AUTH_FAILURE_COOLDOWN_MS = 10 * 60_000;
/** Secondary limits without Retry-After block a member for this long. */
const SECONDARY_LIMIT_DEFAULT_MS = 60_000;

export type GithubTokenIdentity = 'pool' | 'primary';

interface MemberState {
  remaining: number | null;
  resetAt: number;
  blockedUntil: number;
}

const memberState = new Map<string, MemberState>();

function stateFor(token: string): MemberState {
  let state = memberState.get(token);
  if (state === undefined) {
    state = { remaining: null, resetAt: 0, blockedUntil: 0 };
    memberState.set(token, state);
  }
  return state;
}

/** Configured members in pool order, deduplicated. Read at call time. */
export function githubPoolTokens(env: NodeJS.ProcessEnv = process.env): string[] {
  const tokens = POOL_KEYS.map((key) => (env[key] ?? '').trim()).filter((token) => token !== '');
  return [...new Set(tokens)];
}

/** Members ordered best-first: unblocked by most remaining quota (unknown = full), then blocked by soonest recovery. */
export function githubTokenCandidates(
  identity: GithubTokenIdentity = 'pool',
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const tokens = githubPoolTokens(env);
  if (identity === 'primary') {
    const primary = (env.GITHUB_TOKEN ?? '').trim();
    const dispatch = (env.GITHUB_DISPATCH_TOKEN ?? '').trim();
    return [...new Set([primary, dispatch].filter((token) => token !== ''))];
  }
  const now = Date.now();
  const dispatch = (env.GITHUB_DISPATCH_TOKEN ?? '').trim();
  const ranked = tokens.map((token, order) => {
    const state = stateFor(token);
    const exhausted = state.remaining === 0 && state.resetAt > now;
    const blockedUntil = Math.max(state.blockedUntil, exhausted ? state.resetAt : 0);
    // The dispatch token is a fallback, not quota: it ranks after every usable member.
    const lastResort = token === dispatch && tokens.length > 1;
    return {
      token,
      order,
      blockedUntil,
      lastResort,
      remaining: state.remaining ?? Number.POSITIVE_INFINITY,
    };
  });
  ranked.sort((a, b) => {
    const aBlocked = a.blockedUntil > now;
    const bBlocked = b.blockedUntil > now;
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
    if (aBlocked) return a.blockedUntil - b.blockedUntil || a.order - b.order;
    if (a.lastResort !== b.lastResort) return a.lastResort ? 1 : -1;
    return b.remaining - a.remaining || a.order - b.order;
  });
  return ranked.map((entry) => entry.token);
}

/** The best member for this identity, or null when none is configured. */
export function pickGithubToken(identity: GithubTokenIdentity = 'pool'): string | null {
  return githubTokenCandidates(identity)[0] ?? null;
}

/** True for a primary or secondary GitHub rate-limit rejection. */
export function isGithubRateLimited(status: number, headers: Headers, body: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body);
}

/** Learn a member's quota from one response. */
export function recordGithubResponse(
  token: string,
  status: number,
  headers: Headers,
  body = ''
): void {
  const state = stateFor(token);
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (headers.has('x-ratelimit-remaining') && Number.isFinite(remaining)) {
    state.remaining = remaining;
  }
  if (Number.isFinite(reset) && reset > 0) state.resetAt = reset * 1000;
  const now = Date.now();
  if (status === 401) {
    state.blockedUntil = now + AUTH_FAILURE_COOLDOWN_MS;
  } else if (isGithubRateLimited(status, headers, body)) {
    const retryAfter = Number(headers.get('retry-after'));
    state.blockedUntil =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? now + retryAfter * 1000
        : state.remaining === 0 && state.resetAt > now
          ? state.resetAt
          : now + SECONDARY_LIMIT_DEFAULT_MS;
  } else if (status < 400) {
    state.blockedUntil = 0;
  }
}

export interface GithubFetchOptions {
  identity?: GithubTokenIdentity;
  fetchImpl?: typeof fetch;
}

async function sendWithToken(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  token: string
): Promise<{ response: Response; rejected: boolean }> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetchImpl(url, { ...init, headers });
  const body =
    response.status === 401 || response.status === 403 || response.status === 429
      ? await response
          .clone()
          .text()
          .catch(() => '')
      : '';
  recordGithubResponse(token, response.status, response.headers, body);
  const rejected =
    response.status === 401 || isGithubRateLimited(response.status, response.headers, body);
  return { response, rejected };
}

/**
 * fetch() with a pool member's Authorization header. A 401 or rate-limited
 * response is retried on the next member (the request was rejected, so a retry
 * cannot duplicate a write); the last response is returned as-is. A 404 from a
 * machine account is not authoritative (it may lack access to a private repo
 * the primary can read), so it is re-asked once with the primary token and the
 * primary's answer is returned. With no member configured the request is sent
 * unauthenticated, as before.
 */
export async function githubFetch(
  url: string,
  init: RequestInit = {},
  options: GithubFetchOptions = {}
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const candidates = githubTokenCandidates(options.identity ?? 'pool');
  if (candidates.length === 0) return fetchImpl(url, init);
  const primary = (process.env.GITHUB_TOKEN ?? '').trim();
  let response: Response | null = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const token = candidates[index];
    const sent = await sendWithToken(fetchImpl, url, init, token);
    response = sent.response;
    if (response.status === 404 && primary !== '' && token !== primary) {
      return (await sendWithToken(fetchImpl, url, init, primary)).response;
    }
    if (!sent.rejected || index === candidates.length - 1) return response;
    log.warn('GitHub token rejected; trying next pool member', {
      status: response.status,
      member: index + 1,
      members: candidates.length,
    });
  }
  return response as Response;
}

export function resetGithubTokenPoolForTests(): void {
  memberState.clear();
}
