const CODE_AGENT_REPO_WORKDIR = '/home/user/workspace';

export function workDirForGithubRepo(githubRepoUrl?: string): string {
  if (!githubRepoUrl) return '/home/user';
  try {
    const url = new URL(githubRepoUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username ||
      url.password ||
      pathParts.length !== 2
    ) {
      return '/home/user';
    }
    return CODE_AGENT_REPO_WORKDIR;
  } catch {
    return '/home/user';
  }
}
