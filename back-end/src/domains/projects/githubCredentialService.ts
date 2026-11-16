/**
 * The caller's own GitHub credential for code sessions (`rose github status`
 * / `rose github import`); storage and use live in
 * providers/githubUserCredentials.ts.
 *
 *   status(repo?) ─► {connected, login, scopes, verifiedAt}
 *                    + repo: can Rose reach it, and how (user_credential | rose | none)
 *   import(envelope) ─► key check ─► verified with GitHub ─► stored (owner only)
 *
 * Responses never contain the token or its envelope.
 */
import { checkGithubRepoAccess } from '../../providers/github';
import { githubHttpsUrlOfSshRemote, githubRepoIdentity } from '../../providers/githubRepos/refs';
import {
  deleteGithubUserCredential,
  GithubCredentialError,
  githubUserCredentialStatus,
  saveGithubUserCredential,
  userTokenRepoAccess,
  type GithubCredentialStatus,
} from '../../providers/githubUserCredentials';
import { projectSyncKeyId, ProjectSecretsUnavailableError } from '../../providers/projects/secrets';
import { ProjectError } from './service';

export type GithubRepoAccessKind =
  'user_credential' | 'rose' | 'none' | 'rate_limited' | 'not_github';

export interface GithubRepoAccessDto {
  repoUrl: string | null;
  canonicalRef: string | null;
  access: GithubRepoAccessKind;
  /** Why Rose cannot reach it (access none / rate_limited). */
  reason?: string;
}

/** Can Rose reach `raw` (any GitHub spelling, SSH included) for this user, and with what. */
async function repoAccess(userId: string, raw: string): Promise<GithubRepoAccessDto> {
  const identity = githubRepoIdentity(githubHttpsUrlOfSshRemote(raw) ?? raw);
  if (identity === null) return { repoUrl: null, canonicalRef: null, access: 'not_github' };
  const repo = { repoUrl: identity.repoUrl, canonicalRef: identity.canonicalRef };
  const own = await userTokenRepoAccess(userId, identity.owner, identity.repoName);
  if (own?.canPush === true) return { ...repo, access: 'user_credential' };
  const check = await checkGithubRepoAccess(userId, identity.repoUrl);
  if (check.allowed) return { ...repo, access: 'rose' };
  return {
    ...repo,
    access: check.rateLimit !== undefined ? 'rate_limited' : 'none',
    ...(check.error !== undefined ? { reason: check.error } : {}),
  };
}

export async function getGithubCredential(
  userId: string,
  repo: string | undefined
): Promise<GithubCredentialStatus & { repo?: GithubRepoAccessDto }> {
  const status = await githubUserCredentialStatus(userId);
  return repo === undefined ? status : { ...status, repo: await repoAccess(userId, repo) };
}

function asProjectError(error: unknown): never {
  if (error instanceof GithubCredentialError) {
    throw new ProjectError(error.status, error.message, error.code);
  }
  if (error instanceof ProjectSecretsUnavailableError) {
    throw new ProjectError(503, 'Codebase sync is not configured on this server');
  }
  throw error;
}

export async function importGithubCredential(
  userId: string,
  body: { keyId: string; encryptedToken: string }
): Promise<GithubCredentialStatus> {
  try {
    if (body.keyId !== projectSyncKeyId()) {
      throw new ProjectError(
        409,
        'Sync key rotated; fetch /api/projects/sync-key again',
        'key_rotated'
      );
    }
    return await saveGithubUserCredential(userId, body.encryptedToken);
  } catch (error) {
    return asProjectError(error);
  }
}

export function removeGithubCredential(userId: string): Promise<{ deleted: boolean }> {
  return deleteGithubUserCredential(userId);
}
