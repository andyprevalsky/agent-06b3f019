/**
 * STATE MACHINE: useRoseSidebarProjects (project rows + panels beside the left bar)
 *
 * Projects are shown as Folders (same rows and ids; lib/api/folders.ts).
 *
 * FOLDER SETTINGS PANEL (beside the left bar):
 *   [NONE] --⚙ / "Folder settings" on folder P--> [PROJECT(P)]
 *   [PROJECT(P)] --⚙ on project Q--> [PROJECT(Q)]
 *   [PROJECT(P)] --same ⚙ again | close | Escape | P deleted--> [NONE]
 * (Account settings open in the right-panel slot, owned by RoseAppsProvider.)
 *
 * FOLDER MUTATIONS (useProjects, /api/folders): create (inline "+ New folder",
 * POST { name } only, never a repo), rename (inline, PATCH { name }), delete
 * (after the confirm dialog). Failures surface as toasts, except a duplicate
 * name on create (409), which the inline input shows.
 */

import { useCallback, useState } from 'react';

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
  const projects = projectQuery.data ?? [];
  const createMutation = useCreateProject();
  const renameMutation = useRenameProject();
  const deleteMutation = useDeleteProject();
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  const fail = useCallback(
    (description: string) => toast({ title: 'Error', description, variant: 'destructive' }),
    [toast],
  );

  const toggleProjectSettings = useCallback((project: Project) => {
    setSettingsProjectId((prev) => (prev === project.id ? null : project.id));
  }, []);

  const confirmDelete = useCallback(() => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target === null) return;
    setSettingsProjectId((prev) => (prev === target.id ? null : prev));
    deleteMutation.mutate(target.id, { onError: () => fail('Could not delete folder') });
  }, [deleteMutation, deleteTarget, fail]);

  const projectActions: RoseProjectActions = {
    onCreateAgentInProject,
    onOpenProjectSettings: toggleProjectSettings,
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

  const openProject =
    settingsProjectId === null ? null : (projects.find((p) => p.id === settingsProjectId) ?? null);

  return {
    projects,
    projectQuery,
    openProject,
    closeProjectSettings: () => setSettingsProjectId(null),
    renamingProjectId,
    deleteTarget,
    cancelDelete: () => setDeleteTarget(null),
    confirmDelete,
    projectActions,
  };
}
