export const GITHUB_USER_REPOS_URL = 'https://api.github.com/user/repos';

/** Repo-creation call only — ignore concurrent /dispatches and other GitHub URLs. */
export function selectGithubRepoCreationCall<T extends { url: string }>(
  calls: readonly T[]
): T | undefined {
  return calls.find((call) => call.url === GITHUB_USER_REPOS_URL);
}
