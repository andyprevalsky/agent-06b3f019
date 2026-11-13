/**
 * React Query wrappers for the Folders + Projects REST clients. A folder is a
 * project row (lib/api/folders.ts), so the list and every setting stay on
 * /api/projects while create / rename / delete use /api/folders.
 *
 *   useProjects()            GET /api/projects ({ projects }); an error leaves the
 *                            list empty, so every agent stays under Home
 *   useFolderGithubRepo(id)  GET /api/folders: the folder's read-only connected
 *                            repo (connect / change it on the Integrations panel)
 *   useCreateProject()       POST /api/folders { name } (never a repo), then the
 *                            list refetches (409 rejects with DuplicateFolderNameError)
 *   useRenameProject()       PATCH /api/folders/:id { name }, row renamed in place
 *   useUpdateProject()       settings save: a new name via PATCH /api/folders/:id,
 *                            every other field via PUT /api/projects/:id
 *   useDeleteProject()       DELETE /api/folders/:id, row removed (its agents fall
 *                            back to Home)
 *   useProjectEnvFiles(id)   GET /api/projects/:id/env-files (names only)
 *   useCreateProjectEnvFile / useDeleteProjectEnvFile: POST / DELETE an env file,
 *                            then refetch that project's files and the project
 *                            list (its envFileCount changed)
 *   useMaintenance(id)      GET …/maintenance (template snapshot, schedule, recent runs);
 *                            refetches every 3 s while a sync is running
 *   useStartMaintenance(id) POST …/maintenance/runs (Run now / Snapshot now), then refetch
 *   useMaintenanceRun(id,r) GET …/maintenance/runs/:runId (the run's log), only when asked
 * Every mutation also invalidates the lists so the server stays the source of truth.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  FOLDERS_QUERY_KEY,
  createFolder,
  deleteFolder,
  fetchFolders,
  renameFolder,
  type FolderGithubRepo,
} from '@/lib/api/folders';
import {
  PROJECTS_QUERY_KEY,
  createProjectEnvFile,
  deleteProjectEnvFile,
  fetchMaintenance,
  fetchMaintenanceRun,
  fetchProjectEnvFiles,
  fetchProjects,
  startMaintenanceRun,
  updateProject,
  type MaintenanceMode,
  type NewProjectEnvFile,
  type Project,
  type ProjectUpdate,
} from '@/lib/api/projects';

export { PROJECTS_QUERY_KEY };

function envFilesKey(projectId: string) {
  return [...PROJECTS_QUERY_KEY, projectId, 'env-files'] as const;
}

const NO_PROJECTS: Project[] = [];

export function useProjectsQuery() {
  return useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: fetchProjects,
    staleTime: 60_000,
    retry: false,
  });
}

export function useProjects(): Project[] {
  return useProjectsQuery().data ?? NO_PROJECTS;
}

function useProjectsCache() {
  const queryClient = useQueryClient();
  const refetch = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true }),
      // Prefix: also the Integrations panel's user-keyed folders list.
      queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY }),
    ]);
  return {
    refetch,
    edit: (fn: (prev: Project[]) => Project[]) => {
      queryClient.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (prev) => fn(prev ?? []));
      void refetch();
    },
  };
}

export function useFoldersQuery() {
  return useQuery({
    queryKey: FOLDERS_QUERY_KEY,
    queryFn: fetchFolders,
    staleTime: 60_000,
    retry: false,
  });
}

/** The folder's connected repo (read-only); undefined while the folders list loads. */
export function useFolderGithubRepo(projectId: string): FolderGithubRepo | null | undefined {
  const { data } = useFoldersQuery();
  if (data === undefined) return undefined;
  return data.find((folder) => folder.legacy_project_id === projectId)?.github_repo ?? null;
}

export function useCreateProject() {
  const cache = useProjectsCache();
  return useMutation({
    mutationFn: (name: string) => createFolder(name),
    // The folder is a project row; the refetched list carries its full settings.
    onSuccess: () => cache.refetch(),
  });
}

export function useRenameProject() {
  const cache = useProjectsCache();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameFolder(id, name),
    onSuccess: (folder) =>
      cache.edit((prev) => prev.map((p) => (p.id === folder.id ? { ...p, name: folder.name } : p))),
  });
}

/** Settings save: a new name goes through /api/folders, the rest through PUT /api/projects. */
async function saveProjectSettings(project: Project, updates: ProjectUpdate): Promise<Project> {
  const { name, ...rest } = updates;
  let saved = project;
  if (name !== undefined) saved = { ...saved, name: (await renameFolder(project.id, name)).name };
  if (Object.keys(rest).length > 0) saved = await updateProject(project.id, rest);
  return saved;
}

export function useUpdateProject() {
  const cache = useProjectsCache();
  return useMutation({
    mutationFn: ({ project, updates }: { project: Project; updates: ProjectUpdate }) =>
      saveProjectSettings(project, updates),
    onSuccess: (saved) => cache.edit((prev) => prev.map((p) => (p.id === saved.id ? saved : p))),
  });
}

export function useDeleteProject() {
  const cache = useProjectsCache();
  return useMutation({
    mutationFn: (id: string) => deleteFolder(id),
    onSuccess: (_void, id) => cache.edit((prev) => prev.filter((p) => p.id !== id)),
  });
}

export function useProjectEnvFiles(projectId: string) {
  return useQuery({
    queryKey: envFilesKey(projectId),
    queryFn: () => fetchProjectEnvFiles(projectId),
    staleTime: 30_000,
    retry: false,
  });
}

function useEnvFilesRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: envFilesKey(projectId) }),
      queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true }),
    ]);
}

export function useCreateProjectEnvFile(projectId: string) {
  const refresh = useEnvFilesRefresh(projectId);
  return useMutation({
    mutationFn: (file: NewProjectEnvFile) => createProjectEnvFile(projectId, file),
    onSuccess: refresh,
  });
}

export function useDeleteProjectEnvFile(projectId: string) {
  const refresh = useEnvFilesRefresh(projectId);
  return useMutation({
    mutationFn: (fileId: string) => deleteProjectEnvFile(projectId, fileId),
    onSuccess: refresh,
  });
}

function maintenanceKey(projectId: string) {
  return [...PROJECTS_QUERY_KEY, projectId, 'maintenance'] as const;
}

export function useMaintenance(projectId: string) {
  return useQuery({
    queryKey: maintenanceKey(projectId),
    queryFn: () => fetchMaintenance(projectId),
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : false),
  });
}

export function useStartMaintenance(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: MaintenanceMode) => startMaintenanceRun(projectId, mode),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: maintenanceKey(projectId) }),
        queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true }),
      ]),
  });
}

export function useMaintenanceRun(projectId: string, runId: string | null, running: boolean) {
  return useQuery({
    queryKey: [...maintenanceKey(projectId), 'run', runId],
    queryFn: () => fetchMaintenanceRun(projectId, runId ?? ''),
    enabled: runId !== null,
    staleTime: running ? 0 : 60_000,
    retry: false,
    refetchInterval: running ? 3_000 : false,
  });
}
