/**
 * STATE MACHINE: useRoseSidebarProjects (folder rows in the left bar)
 *
 * Folders only organize agents (lib/api/folders.ts; same ids as their project
 * rows). Only rows the server marks as folders are listed: a repository that
 * was connected or imported in Integrations › GitHub Repositories is not a
 * folder. Folders have no settings here (Andy, 2026-11-15).
 *
 * FOLDER MUTATIONS (useProjects, /api/folders): create (inline "+ New folder",
 * POST { name } only, never a repo), rename (inline, PATCH { name }), delete
 * (after the confirm dialog). Failures surface as toasts, except a duplicate
 * name on create (409), which the inline input shows.
 */

import { useCallback, useMemo, useState } from 'react';

import { useToast } from '@/hooks/use-toast';
import { DuplicateFolderNameError } from '@/lib/api/folders';
import type { Project } from '@/lib/api/projects';

import {
  useCreateProject,
  useDeleteProject,
  useProjectsQuery,
  useRenameProject,
} from './useProjects';
import type { RoseProjectActions } from './RoseAgentGroups';

export function useRoseSidebarProjects(
  onCreateAgentInProject: (project: Project, folderId?: string | null) => void,
) {
  const { toast } = useToast();
  const projectQuery = useProjectsQuery();
  const projects = useMemo(
    () => (projectQuery.data ?? []).filter((project) => project.isFolder !== false),
    [projectQuery.data],
  );
  const createMutation = useCreateProject();
  const renameMutation = useRenameProject();
  const deleteMutation = useDeleteProject();
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  const fail = useCallback(
    (description: string) => toast({ title: 'Error', description, variant: 'destructive' }),
    [toast],
  );

  const confirmDelete = useCallback(() => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target === null) return;
    deleteMutation.mutate(target.id, { onError: () => fail('Could not delete folder') });
  }, [deleteMutation, deleteTarget, fail]);

  const projectActions: RoseProjectActions = {
    onCreateAgentInProject,
    onStartRename: (project) => setRenamingProjectId(project.id),
    onCancelRename: () => setRenamingProjectId(null),
    onRename: (project, name) => {
      setRenamingProjectId(null);
      if (name === project.name) return;
      renameMutation.mutate(
        { id: project.id, name },
        {
          onError: (err) =>
            fail(err instanceof DuplicateFolderNameError ? err.message : 'Could not rename folder'),
        },
      );
    },
    onRequestDelete: setDeleteTarget,
    onCreateProject: async (name) => {
      try {
        await createMutation.mutateAsync(name);
        return null;
      } catch (err) {
        if (err instanceof DuplicateFolderNameError) return err.message;
        fail('Could not create folder');
        return 'Could not create folder. Try again.';
      }
    },
  };

  return {
    projects,
    projectQuery,
    renamingProjectId,
    deleteTarget,
    cancelDelete: () => setDeleteTarget(null),
    confirmDelete,
    projectActions,
  };
}
