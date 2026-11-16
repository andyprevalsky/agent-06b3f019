/**
 * STATE MACHINE: useIntegrationProjects (Integrations › Projects)
 *
 *   A project and a GitHub repo are one thing: every listed row is a repository
 *   project (GET /api/projects rows with isRepository; left-bar folders share
 *   the table and are filtered out); connecting a GitHub repo creates or links
 *   its project.
 *
 *   [LOADING] --GET /api/projects--> [READY] | [LIST ERROR]
 *   [READY] --connectGithub(url)--> [CONNECTING] --201--> [READY] (refetched; the
 *     repo is listed as a project) | inline error (403 no access, 400 not a GitHub
 *     URL, 503 rate limited)
 *   [READY] --remove(project)--> [REMOVING id] --204--> [READY] (row gone; the
 *     backend also drops its repo connection) | inline error
 *   refetch() after an import from the computer finishes (its project and the
 *     GitHub account it may have imported)
 *   GitHub account (GET /api/projects/github-credential: {connected, login}, never
 *     the token) --removeGithubAccount--> DELETE --> refetched
 *
 * The list shares PROJECTS_QUERY_KEY with project settings, so a saved name or
 * env file shows on the row without a reload. The query cache is cleared on
 * every account change (scopeQueryCacheToUser), so another account's projects
 * never render. Signed out, nothing is fetched.
 */

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { FOLDERS_QUERY_KEY } from '@/lib/api/folders';
import {
  PROJECTS_QUERY_KEY,
  deleteGithubCredential,
  deleteProject,
  fetchGithubCredential,
  fetchProjects,
  type Project,
} from '@/lib/api/projects';

import { connectGithubRepoApi } from '../api/githubRepos';

const NO_PROJECTS: Project[] = [];
const GITHUB_CREDENTIAL_KEY = [...PROJECTS_QUERY_KEY, 'github-credential'] as const;

function message(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : String(error);
}

export function useIntegrationProjects(enabled: boolean) {
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: fetchProjects,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  const githubAccount = useQuery({
    queryKey: GITHUB_CREDENTIAL_KEY,
    queryFn: fetchGithubCredential,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  const removeGithubMutation = useMutation({
    mutationFn: deleteGithubCredential,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: GITHUB_CREDENTIAL_KEY }),
  });
  // Folders (left bar) share the table; only repositories are listed here.
  const repositories = useMemo(
    () => (projects.data ?? NO_PROJECTS).filter((project) => project.isRepository !== false),
    [projects.data],
  );
  const [removingId, setRemovingId] = useState<string | null>(null);
  const refetch = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true }),
        queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: GITHUB_CREDENTIAL_KEY }),
      ]),
    [queryClient],
  );

  const connectMutation = useMutation({
    mutationFn: (repoUrl: string) => connectGithubRepoApi(repoUrl),
    onSuccess: refetch,
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onMutate: (id) => setRemovingId(id),
    onSuccess: (_void, id) => {
      queryClient.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (prev) =>
        (prev ?? []).filter((project) => project.id !== id),
      );
      return refetch();
    },
    onSettled: () => setRemovingId(null),
  });

  return {
    refetch,
    projects: repositories,
    loading: enabled && projects.isPending,
    listError: message(projects.error),
    connecting: connectMutation.isPending,
    connectError: message(connectMutation.error),
    clearConnectError: () => connectMutation.reset(),
    /** Resolves true when the repo was connected (the form then closes). */
    connectGithub: async (repoUrl: string): Promise<boolean> => {
      try {
        await connectMutation.mutateAsync(repoUrl);
        return true;
      } catch {
        return false;
      }
    },
    removingId,
    removeError: message(removeMutation.error),
    remove: (id: string) => removeMutation.mutate(id),
    /** The GitHub login code agents act as (from `rose github import`); null: none. */
    githubLogin: githubAccount.data?.connected === true ? githubAccount.data.login : null,
    removingGithubAccount: removeGithubMutation.isPending,
    removeGithubAccountError: message(removeGithubMutation.error),
    removeGithubAccount: () => removeGithubMutation.mutate(),
  };
}
