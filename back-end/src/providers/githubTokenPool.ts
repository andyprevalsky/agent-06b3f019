/**
 * GitHub token pool.
 *
 * Members: GITHUB_TOKEN (the primary identity), GITHUB_TOKEN_2 … GITHUB_TOKEN_9
 * (machine accounts), the GitHub App installation token (GITHUB_APP_ID +
 * GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY_B64; minted on demand,
 * refreshed before its one-hour expiry), with GITHUB_DISPATCH_TOKEN kept as the
 * last-resort member for auth fallbacks. Each GitHub user or installation has
 * its own quota, so reads spread across members instead of draining the
 * primary account.
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
import { createSign } from 'node:crypto';

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

/** The learned quota/cooldown record for one member, created on first use. */
function stateFor(token: string): MemberState {
  let state = memberState.get(token);
  if (state === undefined) {
    state = { remaining: null, resetAt: 0, blockedUntil: 0 };
    memberState.set(token, state);
  }
  return state;
}

/** Refresh an installation token this long before GitHub expires it. */
const APP_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** After a failed mint, skip new mints for this long so a bad key or an outage costs one request per window, not one per read. */
const APP_MINT_FAILURE_COOLDOWN_MS = 60_000;
let appMintBlockedUntil = 0;
let appToken: { token: string; expiresAt: number } | null = null;
let appTokenInFlight: Promise<string | null> | null = null;

interface GithubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

/**
 * The app member is minted only in production unless GITHUB_APP_POOL says
 * otherwise (same rule as agent repo creation): local, test and benchmark
 * stacks carry copies of the production env and must not mint, or record,
 * production app tokens.
 */
export function githubAppPoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.GITHUB_APP_POOL ?? '').trim().toLowerCase();
  if (flag === 'on' || flag === 'true') return true;
  if (flag === 'off' || flag === 'false') return false;
  return env.RENDER === 'true';
}

/** The configured GitHub App, or null when the app member is disabled or any setting is blank. */
function githubAppConfig(env: NodeJS.ProcessEnv): GithubAppConfig | null {
  if (!githubAppPoolEnabled(env)) return null;
  const appId = (env.GITHUB_APP_ID ?? '').trim();
  const installationId = (env.GITHUB_APP_INSTALLATION_ID ?? '').trim();
  const keyB64 = (env.GITHUB_APP_PRIVATE_KEY_B64 ?? '').trim();
  if (appId === '' || installationId === '' || keyB64 === '') return null;
  return { appId, installationId, privateKey: Buffer.from(keyB64, 'base64').toString('utf8') };
}

/** URL-safe base64 (no padding), as JWT segments require. */
function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** A ten-minute app JWT (RS256), backdated a minute for clock skew. */
export function githubAppJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })
  )}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

/** Mint one installation token; a failure starts the mint cooldown and returns any still-valid token. */
async function mintGithubAppToken(
  config: GithubAppConfig,
  fetchImpl: typeof fetch
): Promise<string | null> {
  const base = (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
  try {
    const response = await fetchImpl(
      `${base}/app/installations/${config.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubAppJwt(config.appId, config.privateKey)}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) {
      appMintBlockedUntil = Date.now() + APP_MINT_FAILURE_COOLDOWN_MS;
      log.warn('GitHub App installation token mint failed', { status: response.status });
      return currentAppToken() || null;
    }
    const body = (await response.json()) as { token?: string; expires_at?: string };
    const expiresAt = Date.parse(body.expires_at ?? '');
    if (typeof body.token !== 'string' || body.token === '' || !Number.isFinite(expiresAt)) {
      appMintBlockedUntil = Date.now() + APP_MINT_FAILURE_COOLDOWN_MS;
      log.warn('GitHub App installation token response was malformed');
      return currentAppToken() || null;
    }
    if (appToken !== null) memberState.delete(appToken.token);
    appToken = { token: body.token, expiresAt };
    appMintBlockedUntil = 0;
    return body.token;
  } catch (error) {
    appMintBlockedUntil = Date.now() + APP_MINT_FAILURE_COOLDOWN_MS;
    log.warn('GitHub App installation token mint errored', {
      error: error instanceof Error ? error.message : String(error),
    });
    return currentAppToken() || null;
  }
}

/**
 * Make sure the GitHub App member holds an unexpired installation token.
 * Concurrent callers share one mint; a failed mint keeps any still-valid token,
 * starts a cooldown (no new mint until it ends) and never blocks the static
 * members. Returns null when no app is configured.
 */
export async function ensureGithubAppToken(
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const config = githubAppConfig(process.env);
  if (config === null) return null;
  if (appToken !== null && appToken.expiresAt - Date.now() > APP_TOKEN_REFRESH_MARGIN_MS) {
    return appToken.token;
  }
  if (Date.now() < appMintBlockedUntil) return currentAppToken() || null;
  appTokenInFlight ??= mintGithubAppToken(config, fetchImpl).finally(() => {
    appTokenInFlight = null;
  });
  return appTokenInFlight;
}

/** The installation token while it is unexpired, else an empty string. */
function currentAppToken(): string {
  return appToken !== null && appToken.expiresAt > Date.now() ? appToken.token : '';
}

/** Configured members in pool order, deduplicated. Read at call time. */
export function githubPoolTokens(env: NodeJS.ProcessEnv = process.env): string[] {
  const staticTokens = POOL_KEYS.filter((key) => key !== 'GITHUB_DISPATCH_TOKEN').map((key) =>
    (env[key] ?? '').trim()
  );
  const tokens = [...staticTokens, currentAppToken(), (env.GITHUB_DISPATCH_TOKEN ?? '').trim()];
  return [...new Set(tokens.filter((token) => token !== ''))];
}

/** Members ordered best-first: unblocked by most remaining quota (unknown = full), then blocked by soonest recovery. */
export function githubTokenCandidates(
  identity: GithubTokenIdentity = 'pool',
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const tokens = githubPoolTokens(env);
  if (identity === 'primary') {
    // Writes that act as Andy use GITHUB_TOKEN alone: never a machine account, the app or the dispatch token.
    const primary = (env.GITHUB_TOKEN ?? '').trim();
    return primary === '' ? [] : [primary];
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

/** Send one request with one member's token, record what GitHub says about it, and report whether it was rejected. */
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
  // Quota learning is advisory and must never throw into the read: a minimal response
  // double without headers is passed through untouched.
  const learned: Headers | undefined = response.headers;
  recordGithubResponse(token, response.status, learned ?? new Headers(), body);
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
  if ((options.identity ?? 'pool') === 'pool') await ensureGithubAppToken(fetchImpl);
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

/** Test hook: forget every learned quota, the cached app token and the mint cooldown. */
export function resetGithubTokenPoolForTests(): void {
  appMintBlockedUntil = 0;
  memberState.clear();
  appToken = null;
  appTokenInFlight = null;
}
