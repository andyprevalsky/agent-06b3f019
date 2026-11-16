/**
 * A user's own GitHub credential ("the gh cred comes with the project").
 *
 *   rose github import ── envelope (project sync key, like env files) ──► POST /api/projects/github-credential
 *        └─► decrypt ─► GitHub GET /user (login, X-OAuth-Scopes) ─► Integration{name: github_user_credential}
 *                                                    config {login, scopes, verified_at, encrypted_token}
 *   checkGithubRepoAccess(user, repo) ─► this token can push the repo ─► allowed (grant recorded)
 *   the user's code sessions ─► clone/push URL, GH_TOKEN and commit identity from this token
 *
 * Private to its owner: every read is keyed by the session's own userId (a
 * teammate's session never sees it), teams share only gmail/imessage rows, and
 * the envelope never leaves the backend (stripped from integration lists by
 * redactGithubUserCredential). The plaintext token is never logged or returned.
 *
 * 10k-agent behaviour: one row per user; a repo decision is cached per
 * (user, repo) for five minutes per process (bounded map), so a burst of
 * sessions on one repo costs one GitHub read with the user's own quota.
 */
import { IntegrationStatus, IntegrationType, type Prisma } from '@prisma/client';
import { prisma } from './database';
import { githubApiBase } from './githubRateLimit';
import { createLogger } from './logger';
import { decryptProjectSecret } from './projects/secrets';

const log = createLogger('GithubUserCredentials');

export const GITHUB_USER_CREDENTIAL_INTEGRATION = 'github_user_credential';
const REQUEST_TIMEOUT_MS = 10_000;
const ACCESS_CACHE_TTL_MS = 5 * 60_000;
const ACCESS_CACHE_MAX = 10_000;

export class GithubCredentialError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'GithubCredentialError';
  }
}

export interface GithubCredentialStatus {
  connected: boolean;
  login: string | null;
  scopes: string[];
  verifiedAt: string | null;
}

interface StoredConfig {
  login?: unknown;
  scopes?: unknown;
  verified_at?: unknown;
  encrypted_token?: unknown;
}

const key = (userId: string) => ({
  userId_name_accountId: { userId, name: GITHUB_USER_CREDENTIAL_INTEGRATION, accountId: '' },
});

/** Integration list rows never carry the envelope (only login, scopes, verified_at). */
export function redactGithubUserCredential<T extends { name: string; config: unknown }>(row: T): T {
  if (row.name !== GITHUB_USER_CREDENTIAL_INTEGRATION) return row;
  const config = (row.config ?? {}) as StoredConfig;
  return {
    ...row,
    config: { login: config.login, scopes: config.scopes, verified_at: config.verified_at },
  };
}

function statusOf(config: StoredConfig | null): GithubCredentialStatus {
  if (config === null || typeof config.encrypted_token !== 'string') {
    return { connected: false, login: null, scopes: [], verifiedAt: null };
  }
  return {
    connected: true,
    login: typeof config.login === 'string' ? config.login : null,
    scopes: Array.isArray(config.scopes) ? config.scopes.filter((s) => typeof s === 'string') : [],
    verifiedAt: typeof config.verified_at === 'string' ? config.verified_at : null,
  };
}

async function storedConfig(userId: string): Promise<StoredConfig | null> {
  const row = await prisma.integration.findUnique({
    where: key(userId),
    select: { config: true, isActive: true, status: true },
  });
  if (row === null || !row.isActive || row.status !== IntegrationStatus.CONNECTED) return null;
  return (row.config ?? {}) as StoredConfig;
}

function githubRequest(path: string, token: string, fetchImpl: typeof fetch) {
  return fetchImpl(`${githubApiBase()}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rose-github-user-credential',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

const accessCache = new Map<string, { at: number; canPush: boolean; login: string | null }>();

function forgetUser(userId: string): void {
  for (const cacheKey of accessCache.keys()) {
    if (cacheKey.startsWith(`${userId}\n`)) accessCache.delete(cacheKey);
  }
}

export function resetGithubUserCredentialCacheForTests(): void {
  accessCache.clear();
}

/**
 * Verify and store the user's GitHub token, sent as a project-sync envelope.
 * The token is checked against GitHub (`GET /user`) before anything is saved.
 */
export async function saveGithubUserCredential(
  userId: string,
  encryptedToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<GithubCredentialStatus> {
  const token = decryptProjectSecret(encryptedToken)?.trim() ?? '';
  if (token === '' || /\s/.test(token) || token.length > 512) {
    throw new GithubCredentialError(
      400,
      'INVALID_GITHUB_CREDENTIAL',
      'GitHub credential could not be read'
    );
  }
  let response: Response;
  try {
    response = await githubRequest('/user', token, fetchImpl);
  } catch (error) {
    log.warn('GitHub /user unreachable while verifying a user credential', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new GithubCredentialError(
      502,
      'GITHUB_UNREACHABLE',
      'GitHub could not be reached; try again'
    );
  }
  if (!response.ok) {
    log.info('GitHub rejected a user credential', { userId, status: response.status });
    throw new GithubCredentialError(
      400,
      'GITHUB_CREDENTIAL_REJECTED',
      `GitHub rejected this credential (HTTP ${response.status}); sign in again with \`gh auth login\``
    );
  }
  const account = (await response.json()) as { login?: unknown };
  const login = typeof account.login === 'string' ? account.login : null;
  if (login === null) {
    throw new GithubCredentialError(
      400,
      'GITHUB_CREDENTIAL_REJECTED',
      'GitHub returned no account'
    );
  }
  const scopes = (response.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const config: Prisma.InputJsonObject = {
    login,
    scopes,
    verified_at: new Date().toISOString(),
    encrypted_token: encryptedToken,
  };
  const row = await prisma.integration.upsert({
    where: key(userId),
    create: {
      userId,
      name: GITHUB_USER_CREDENTIAL_INTEGRATION,
      accountId: '',
      accountEmail: null,
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config,
    },
    update: { status: IntegrationStatus.CONNECTED, isActive: true, failureReason: null, config },
    select: { id: true },
  });
  forgetUser(userId);
  log.info('GitHub user credential saved', { userId, integrationId: row.id, login, scopes });
  return statusOf(config as StoredConfig);
}

export async function githubUserCredentialStatus(userId: string): Promise<GithubCredentialStatus> {
  return statusOf(await storedConfig(userId));
}

export async function deleteGithubUserCredential(userId: string): Promise<{ deleted: boolean }> {
  const deleted = await prisma.integration.deleteMany({
    where: { userId, name: GITHUB_USER_CREDENTIAL_INTEGRATION },
  });
  forgetUser(userId);
  log.info('GitHub user credential deleted', { userId, deleted: deleted.count });
  return { deleted: deleted.count > 0 };
}

/** The user's own token and login (never logged), or null when they have none. */
export async function githubUserToken(
  userId: string
): Promise<{ token: string; login: string | null } | null> {
  const config = await storedConfig(userId);
  if (config === null || typeof config.encrypted_token !== 'string') return null;
  const token = decryptProjectSecret(config.encrypted_token)?.trim() ?? '';
  if (token === '') {
    log.warn('GitHub user credential could not be decrypted', { userId });
    return null;
  }
  return { token, login: typeof config.login === 'string' ? config.login : null };
}

/**
 * Whether the user's own token can push `owner/repo` (null: no token). One
 * GitHub read per (user, repo) per five minutes per process.
 */
export async function userTokenRepoAccess(
  userId: string,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ canPush: boolean; login: string | null } | null> {
  const own = await githubUserToken(userId);
  if (own === null) return null;
  const cacheKey = `${userId}\n${owner}/${repo}`.toLowerCase();
  const cached = accessCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < ACCESS_CACHE_TTL_MS) {
    return { canPush: cached.canPush, login: cached.login };
  }
  let canPush = false;
  try {
    const response = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      own.token,
      fetchImpl
    );
    if (response.ok) {
      const data = (await response.json()) as { permissions?: { push?: unknown } };
      canPush = data.permissions?.push === true;
    } else {
      log.info('User GitHub credential cannot read repo', {
        userId,
        repo: `${owner}/${repo}`,
        status: response.status,
      });
    }
  } catch (error) {
    // Not cached: the next session retries.
    log.warn('GitHub unreachable for a user credential repo check', {
      userId,
      repo: `${owner}/${repo}`,
      error: error instanceof Error ? error.message : String(error),
    });
    return { canPush: false, login: own.login };
  }
  if (accessCache.size >= ACCESS_CACHE_MAX) {
    const oldest = accessCache.keys().next().value;
    if (oldest !== undefined) accessCache.delete(oldest);
  }
  accessCache.set(cacheKey, { at: Date.now(), canPush, login: own.login });
  return { canPush, login: own.login };
}

/**
 * The session credential for `owner/repo`: the user's own token when it can
 * push the repo, else null (the caller uses the platform token). Always keyed
 * by the session's own user, so a teammate never gets an owner's token.
 */
export async function userGithubSessionToken(
  userId: string | undefined,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ token: string; login: string | null } | null> {
  if (userId === undefined || userId === '') return null;
  const access = await userTokenRepoAccess(userId, owner, repo, fetchImpl);
  if (access === null || !access.canPush) return null;
  return githubUserToken(userId);
}
