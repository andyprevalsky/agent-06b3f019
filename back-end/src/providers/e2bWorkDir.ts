const CODE_AGENT_REPO_WORKDIR = '/home/user/workspace';

export function workDirForGithubRepo(githubRepoUrl?: string): string {
  if (!githubRepoUrl) return '/home/user';
  try {
    new URL(githubRepoUrl);
    return CODE_AGENT_REPO_WORKDIR;
  } catch {
    return '/home/user';
  }
}
