/**
 * React Query wrappers for the Projects REST client (lib/api/projects.ts).
 *
 *   useProjects()        GET /api/projects (an error leaves the list empty, so
 *                        every agent stays under Home)
 *   useCreateProject()   POST, then the new project is appended to the list
 *   useUpdateProject()   PATCH /api/projects/:id, saved project replaces the row
 *   useDeleteProject()   DELETE /api/projects/:id, row removed (its agents fall
 *                        back to Home)
 * Every mutation also invalidates the list so the server stays the source of truth.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createProject,
  deleteProject,
  fetchProjects,
  updateProject,
  type Project,
  type ProjectUpdate,
} from '@/lib/api/projects';

export const PROJECTS_QUERY_KEY = ['projects'] as const;

const NO_PROJECTS: Project[] = [];

export function useProjects(): Project[] {
  const query = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: fetchProjects,
    staleTime: 60_000,
    retry: false,
  });
  return query.data ?? NO_PROJECTS;
}

function useProjectsCache() {
  const queryClient = useQueryClient();
  return {
    edit: (fn: (prev: Project[]) => Project[]) => {
      queryClient.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (prev) => fn(prev ?? []));
      void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
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
