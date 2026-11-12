/**
 * STATE MACHINE: useGithubRepos (GitHub Repo section of the Integrations panel)
 *
 *   [LOADING] --GET /integrations/github/repos--> [READY] (connected repos, incl. ones
 *             auto-imported from a project such as the Rose repo) | [LIST ERROR]
 *   [READY] --connect {repo_url, connected_rose_project_ref?}--> [CONNECTING]
 *     --201--> [READY] (list, folders and projects refetched) | inline connect error
 *             (403 access denied, 409 folder has another repo, 404 folder gone,
 *              400 not a GitHub URL, 503 rate limited)
 *   [READY] --disconnect(ref)--> [DISCONNECTING ref] --done--> [READY] (refetched)
 *                                                    --fail--> inline error on the list
 *
 * Folders (GET /api/folders) feed the optional folder picker and share their cache
 * with the left bar, so a folder's settings show the new repo without a reload.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { FOLDERS_QUERY_KEY, fetchFolders } from '@/lib/api/folders';
import { PROJECTS_QUERY_KEY } from '@/lib/api/projects';

import {
  connectGithubRepoApi,
  disconnectGithubRepoApi,
  fetchGithubReposApi,
  type ConnectGithubRepoInput,
} from '../api/githubRepos';

export const GITHUB_REPOS_QUERY_KEY = ['integrations', 'github', 'repos'] as const;

function message(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : String(error);
}

export function useGithubRepos(enabled: boolean) {
  const queryClient = useQueryClient();
  const repos = useQuery({
    queryKey: GITHUB_REPOS_QUERY_KEY,
    queryFn: fetchGithubReposApi,
    enabled,
    retry: false,
  });
  const folders = useQuery({
    queryKey: FOLDERS_QUERY_KEY,
    queryFn: fetchFolders,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  const [disconnectingRef, setDisconnectingRef] = useState<string | null>(null);

  const refetchAll = () =>
    Promise.all(
      [GITHUB_REPOS_QUERY_KEY, FOLDERS_QUERY_KEY, PROJECTS_QUERY_KEY].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey, exact: true }),
      ),
    );

  const connectMutation = useMutation({
    mutationFn: (input: ConnectGithubRepoInput) => connectGithubRepoApi(input),
    onSuccess: refetchAll,
  });
  const disconnectMutation = useMutation({
    mutationFn: (canonicalRef: string) => disconnectGithubRepoApi(canonicalRef),
    onMutate: (canonicalRef) => setDisconnectingRef(canonicalRef),
    onSuccess: refetchAll,
    onSettled: () => setDisconnectingRef(null),
  });

  return {
    repos: repos.data ?? [],
    loading: enabled && repos.isPending,
    listError: message(repos.error),
    folders: folders.data ?? [],
    connecting: connectMutation.isPending,
    connectError: message(connectMutation.error),
    disconnectingRef,
    disconnectError: message(disconnectMutation.error),
    /** Resolves true when the repo was connected (the form then clears). */
    connect: async (input: ConnectGithubRepoInput): Promise<boolean> => {
      disconnectMutation.reset();
      try {
        await connectMutation.mutateAsync(input);
        return true;
      } catch {
        return false;
      }
    },
    disconnect: (canonicalRef: string) => {
      connectMutation.reset();
      disconnectMutation.mutate(canonicalRef);
    },
    clearConnectError: () => connectMutation.reset(),
  };
}
