/**
 * Pure helpers for a project's GitHub icon (UI item 32).
 *
 * GitHub repositories have no icon of their own; GitHub shows the owner's
 * avatar. One stable URL per owner lets the browser cache serve every row and
 * surface with no API call of ours.
 */

/** GitHub login: 1-39 letters, digits or hyphens, not starting with a hyphen. */
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** scp-style SSH remote, e.g. `git@github.com:owner/repo.git` (user optional). */
const SCP_REMOTE = /^(?:[\w.-]+@)?github\.com:(?!\d+(?:\/|$))(.+)$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const REMOTE_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:']);

function repoPath(repoUrl: string): string | null {
  const scp = SCP_REMOTE.exec(repoUrl);
  if (scp) return scp[1];
  let url: URL;
  try {
    url = new URL(URL_SCHEME.test(repoUrl) ? repoUrl : `https://${repoUrl}`);
  } catch {
    return null;
  }
  if (!REMOTE_PROTOCOLS.has(url.protocol)) return null;
  return GITHUB_HOSTS.has(url.hostname.toLowerCase()) ? url.pathname : null;
}

/**
 * Owner of a GitHub repo URL (`https://github.com/<owner>/<repo>[.git][/]`,
 * `git@github.com:<owner>/<repo>.git`, `ssh://git@github.com/<owner>/<repo>`),
 * or null for no repo, another host, or a URL without an owner and repo.
 */
export function githubRepoOwner(repoUrl: string | null | undefined): string | null {
  const trimmed = repoUrl?.trim();
  if (!trimmed) return null;
  const path = repoPath(trimmed);
  if (path === null) return null;
  const [owner, repo] = path.split('/').filter((segment) => segment !== '');
  if (owner === undefined || repo === undefined || !GITHUB_LOGIN.test(owner)) return null;
  return owner;
}

/**
 * The owner's avatar: one stable, browser-cached URL per owner (20px icon, 64px
 * source). Logins are case-insensitive, so the URL uses the lowercased login.
 */
export function githubOwnerAvatarUrl(owner: string): string {
  return `https://avatars.githubusercontent.com/${owner.toLowerCase()}?size=64`;
}
