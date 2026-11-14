import { useCallback, useEffect, useState } from 'react';
import { fetchConnectedGithubRepos, type ConnectedGithubRepo } from '../../hooks';

/** No explicit repo: the backend uses the inherited / connected-project repo. */
export const INHERIT_GITHUB_REPO = '';

/** The selection's clear error when the backend refuses it (404 'GitHub repo not connected'). */
export function githubRepoRefError(ref: string, message: string): string | null {
  if (ref === INHERIT_GITHUB_REPO || !/github repo/i.test(message)) return null;
  return `GitHub repo ${ref} is not connected. Choose a connected repo or connect it in Integrations.`;
}

/**
 * The GitHub repo picked for a new agent: options from the user's connected repos
 * (GET /api/integrations/github/repos) plus the inherited default. An explicit pick
 * is sent as github_repo_ref and wins over the inherited repo; one the backend
 * refuses shows an inline error and is never swapped for another repo.
 */
export function useGithubRepoSelection(open: boolean) {
  const [githubRepoRef, setRef] = useState(INHERIT_GITHUB_REPO);
  const [githubRepos, setGithubRepos] = useState<ConnectedGithubRepo[]>([]);
  const [githubReposError, setGithubReposError] = useState<string | null>(null);
  const [githubRepoRefErrorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Every open starts from the inherited default.
    setRef(INHERIT_GITHUB_REPO);
    setErrorText(null);
    setGithubReposError(null);
    fetchConnectedGithubRepos()
      .then(setGithubRepos)
      .catch((error: unknown) => {
        setGithubRepos([]);
        setGithubReposError(
          error instanceof Error ? error.message : 'Failed to load connected GitHub repos',
        );
      });
  }, [open]);

  const setGithubRepoRef = useCallback((ref: string) => {
    setRef(ref);
    setErrorText(null);
  }, []);

  /**
   * The create request's repo field: omitted when inheriting. A pick no longer among
   * the connected repos throws the not-connected error instead of being swapped.
   */
  const requestField = useCallback((): { github_repo_ref?: string } => {
    if (githubRepoRef === INHERIT_GITHUB_REPO) return {};
    if (!githubRepos.some((repo) => repo.canonical_ref === githubRepoRef)) {
      throw new Error('GitHub repo not connected');
    }
    return { github_repo_ref: githubRepoRef };
  }, [githubRepoRef, githubRepos]);

  /** A failed submit's toast text; a refused repo also gets the inline error naming it. */
  const describeSubmitError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to create agent';
      const repoError = githubRepoRefError(githubRepoRef, message);
      setErrorText(repoError);
      return repoError ?? message;
    },
    [githubRepoRef],
  );

  return {
    githubRepoRef,
    setGithubRepoRef,
    githubRepos,
    githubReposError,
    githubRepoRefError: githubRepoRefErrorText,
    requestField,
    describeSubmitError,
  };
}
