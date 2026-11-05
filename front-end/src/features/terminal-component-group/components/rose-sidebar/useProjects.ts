/**
 * React Query wrappers for the Projects REST client (lib/api/projects.ts).
 *
 *   useProjects()            GET /api/projects ({ projects }); an error leaves the
 *                            list empty, so every agent stays under Home
 *   useCreateProject()       POST, then the new project is appended to the list
 *                            (409 rejects with DuplicateProjectNameError)
 *   useUpdateProject()       PUT /api/projects/:id, saved project replaces the row
 *   useDeleteProject()       DELETE /api/projects/:id, row removed (its agents fall
 *                            back to Home)
 *   useProjectEnvFiles(id)   GET /api/projects/:id/env-files (names only)
 *   useCreateProjectEnvFile / useDeleteProjectEnvFile: POST / DELETE an env file,
 *                            then refetch that project's files and the project
 *                            list (its envFileCount changed)
 *   useMaintenance(id)      GET …/maintenance (template snapshot, schedule, recent runs);
 *                            refetches every 3 s while a sync is running
 *   useStartMaintenance(id) POST …/maintenance/runs (Run now / Snapshot now), then refetch
 *   useMaintenanceRun(id,r) GET …/maintenance/runs/:runId (the run's log), only when asked
 * Every mutation also invalidates the list so the server stays the source of truth.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createProject,
  createProjectEnvFile,
  deleteProject,
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

export const PROJECTS_QUERY_KEY = ['projects'] as const;

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
  return {
    edit: (fn: (prev: Project[]) => Project[]) => {
      queryClient.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (prev) => fn(prev ?? []));
      void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
    },
  };
}

export function useCreateProject() {
  const cache = useProjectsCache();
  return useMutation({
    mutationFn: (name: string) => createProject(name),
    onSuccess: (created) => cache.edit((prev) => [...prev, created]),
  });
}

export function useUpdateProject() {
  const cache = useProjectsCache();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: ProjectUpdate }) =>
      updateProject(id, updates),
    onSuccess: (saved) => cache.edit((prev) => prev.map((p) => (p.id === saved.id ? saved : p))),
  });
}

export function useDeleteProject() {
  const cache = useProjectsCache();
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
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
