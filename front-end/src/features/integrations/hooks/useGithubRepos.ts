/**
 * STATE MACHINE: useGithubRepos (GitHub Repo section of the Integrations panel)
 *
 *   [LOADING] --GET /integrations/github/repos--> [READY] (connected repos, incl. ones
 *             auto-imported from a project such as the Rose repo) | [LIST ERROR]
 *   [READY] --connect {repo_url, connected_rose_project_ref?}--> [CONNECTING]
 *     --201--> [READY] (list, folders and projects refetched) | inline connect error
 *             (403 access denied, 409 folder has another repo, 404 folder gone,
 *              400 not a GitHub URL, 503 rate limited)
 *   [READY] --switchRepo(folder, repo_url)--> [SWITCHING] (POST ... replace: true: the
 *     folder's old repo stays connected, unassociated) --201--> [READY] (refetched)
 *     | inline switch error
 *   [READY] --disconnect(ref)--> [DISCONNECTING ref] --done--> [READY] (refetched)
 *                                                    --fail--> inline error on the list
 *
 * Folders (GET /api/folders) feed the optional folder picker. Every change
 * invalidates the left bar's folders too, so a folder's settings show the new repo
 * without a reload.
 *
 * Both queries are keyed by the signed-in user id: after a sign-out and a different
 * sign-in on the same device, the panel never renders the previous account's cached
 * repos or folders (it loads the new account's). Signed out, nothing is fetched.
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

export function useGithubRepos(enabled: boolean, userId: string | null) {
  const queryClient = useQueryClient();
  const active = enabled && userId !== null;
  const repos = useQuery({
    queryKey: [...GITHUB_REPOS_QUERY_KEY, userId],
    queryFn: fetchGithubReposApi,
    enabled: active,
    retry: false,
  });
  const folders = useQuery({
    queryKey: [...FOLDERS_QUERY_KEY, userId],
    queryFn: fetchFolders,
    enabled: active,
    staleTime: 60_000,
    retry: false,
  });
  const [disconnectingRef, setDisconnectingRef] = useState<string | null>(null);

  // Prefix matches: the user-keyed queries here and the left bar's folders list.
  const refetchAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: GITHUB_REPOS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true }),
    ]);

  const connectMutation = useMutation({
    mutationFn: (input: ConnectGithubRepoInput) => connectGithubRepoApi(input),
    onSuccess: refetchAll,
  });
  const switchMutation = useMutation({
    mutationFn: ({ folderId, repoUrl }: { folderId: string; repoUrl: string }) =>
      connectGithubRepoApi({
        repo_url: repoUrl,
        connected_rose_project_ref: folderId,
        replace: true,
      }),
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
    loading: active && repos.isPending,
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
    switching: switchMutation.isPending,
    switchError: message(switchMutation.error),
    /** Point a folder that already has a repo at another one; resolves true on success. */
    switchRepo: async (folderId: string, repoUrl: string): Promise<boolean> => {
      try {
        await switchMutation.mutateAsync({ folderId, repoUrl });
        return true;
      } catch {
        return false;
      }
    },
    clearSwitchError: () => switchMutation.reset(),
  };
}
