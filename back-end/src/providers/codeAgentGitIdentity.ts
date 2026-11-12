/**
 * The git author/committer every cloud code sandbox commits as.
 *
 * Vercel builds a commit only when GitHub links its author email to a GitHub
 * account (the commit's `author` object; null = "GitHub couldn't verify an
 * account for the commit", the deploy is blocked). A hard-coded
 * `agent@roselabs.ai` belongs to no account, so every code-agent commit that
 * reached main's HEAD blocked the production front-end (2026-11-12).
 *
 *   GITHUB_TOKEN ──GET /user──▶ { id, login, name }        (once per token per process)
 *        │                              │
 *        │                              ▼
 *        │          <id>+<login>@users.noreply.github.com   (GitHub links it to the account, always)
 *        ▼                              │
 *   sandbox clone/push           GIT_AUTHOR_* / GIT_COMMITTER_* sandbox envs
 *                                       │  env beats repo config, so a template-baked
 *                                       ▼  ws-server or restored checkout cannot override it
 *                               code agent's `git commit` ──push──▶ GitHub ──▶ Vercel builds it
 *
 * The identity is the account whose token pushes: the commits are that
 * account's work as far as GitHub, Vercel and branch protection can tell.
 * 10k agents: one GitHub call per token per backend process, then a cached
 * promise; no per-agent request.
 */
import { createHash } from 'node:crypto';

import { createLogger } from './logger';

const log = createLogger('CodeAgentGitIdentity');

const GITHUB_USER_URL = 'https://api.github.com/user';
const RESOLVE_TIMEOUT_MS = 15_000;

export interface GitCommitIdentity {
  /** GitHub login of the token's account. */
  login: string;
  name: string;
  /** The account's GitHub no-reply address: always linked to that account. */
  email: string;
}

export class GitCommitIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitCommitIdentityError';
  }
}

/** GitHub's per-account no-reply commit email (linked to the account by id). */
export function githubNoreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/** Sandbox envs that make every git commit use `identity`, whatever the repo config says. */
export function gitIdentityEnvs(identity: GitCommitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

const resolved = new Map<string, Promise<GitCommitIdentity>>();

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function fetchIdentity(token: string, fetchImpl: typeof fetch): Promise<GitCommitIdentity> {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'rose-code-agent-git-identity',
      },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitCommitIdentityError(
      `GitHub /user unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 200);
    throw new GitCommitIdentityError(`GitHub /user returned ${response.status}: ${body}`);
  }
  const user = (await response.json()) as { id?: unknown; login?: unknown; name?: unknown };
  if (typeof user.id !== 'number' || typeof user.login !== 'string' || user.login === '') {
    throw new GitCommitIdentityError('GitHub /user returned no account id/login for the token');
  }
  const name =
    typeof user.name === 'string' && user.name.trim() !== '' ? user.name.trim() : user.login;
  return { login: user.login, name, email: githubNoreplyEmail(user.id, user.login) };
}

/**
 * The commit identity of `token`'s GitHub account. Cached per token for the
 * process; a failure is not cached, so the next session retries.
 */
export function resolveGitCommitIdentity(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<GitCommitIdentity> {
  const key = tokenKey(token);
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;
  const pending = fetchIdentity(token, fetchImpl).then(
    (identity) => {
      log.info('Resolved code-agent git identity', {
        login: identity.login,
        email: identity.email,
      });
      return identity;
    },
    (error: unknown) => {
      resolved.delete(key);
      throw error;
    }
  );
  resolved.set(key, pending);
  return pending;
}

/**
 * Identity envs for a sandbox that pushes with `token` (the backend
 * GITHUB_TOKEN). Throws when the account cannot be resolved: a commit under an
 * unlinked identity would land but never deploy, which is worse than a clear
 * start failure.
 */
export async function codeAgentGitIdentityEnvs(
  token: string | undefined = process.env.GITHUB_TOKEN,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, string>> {
  if (token === undefined || token.trim() === '') return {};
  return gitIdentityEnvs(await resolveGitCommitIdentity(token.trim(), fetchImpl));
}

/**
 * The identity envs a code sandbox gets: the pushing account's when the
 * session has a repository to push (a `github_repo_url` session or a project
 * with a repo), none otherwise.
 */
export async function codeSandboxGitIdentityEnvs(
  repoUrl: string | null | undefined,
  token: string | undefined = process.env.GITHUB_TOKEN,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, string>> {
  if (repoUrl === null || repoUrl === undefined || repoUrl.trim() === '') return {};
  return codeAgentGitIdentityEnvs(token, fetchImpl);
}

/**
 * Every GitHub env a cloud code sandbox gets: the clone/push credential for a
 * `github_repo_url` session, and the pushing account's commit identity for any
 * session with a repository (a project's repo is cloned with the same token).
 */
export async function codeSandboxGithubEnvs(
  githubRepoUrl: string | null | undefined,
  projectRepoUrl: string | null | undefined,
  label: '' | 'Codex',
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, string>> {
  const envs: Record<string, string> = {};
  if (githubRepoUrl) {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN not configured - cannot clone repositories');
    }
    envs.GITHUB_REPO_URL = githubRepoUrl;
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    log.info(`GitHub repo configured${label ? ` for ${label}` : ''}: ${githubRepoUrl}`);
  }
  const identity = await codeSandboxGitIdentityEnvs(
    githubRepoUrl ?? projectRepoUrl,
    process.env.GITHUB_TOKEN,
    fetchImpl
  );
  return { ...envs, ...identity };
}

export function resetGitCommitIdentityCacheForTests(): void {
  resolved.clear();
}
