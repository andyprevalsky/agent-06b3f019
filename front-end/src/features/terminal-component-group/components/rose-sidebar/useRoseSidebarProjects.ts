/**
 * STATE MACHINE: useRoseSidebarProjects (project rows + panels beside the left bar)
 *
 * PROJECT SETTINGS PANEL (beside the left bar):
 *   [NONE] --⚙ / "Project settings" on project P--> [PROJECT(P)]
 *   [PROJECT(P)] --⚙ on project Q--> [PROJECT(Q)]
 *   [PROJECT(P)] --same ⚙ again | close | Escape | P deleted--> [NONE]
 * (Account settings open in the right-panel slot, owned by RoseAppsProvider.)
 *
 * PROJECT MUTATIONS (useProjects): create (inline "+ New project"), rename
 * (inline, PUT { name }), delete (after the confirm dialog). Failures surface as
 * toasts, except a duplicate name on create (409), which the inline input shows.
 */

import { useCallback, useState } from 'react';

import { useToast } from '@/hooks/use-toast';
import { DuplicateProjectNameError, type Project } from '@/lib/api/projects';

import {
  useCreateProject,
  useDeleteProject,
  useProjectsQuery,
  useUpdateProject,
} from './useProjects';
import type { RoseProjectActions } from './RoseAgentGroups';

export function useRoseSidebarProjects(onCreateAgentInProject: (project: Project) => void) {
  const { toast } = useToast();
  const projectQuery = useProjectsQuery();
  const projects = projectQuery.data ?? [];
  const createMutation = useCreateProject();
  const updateMutation = useUpdateProject();
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
    deleteMutation.mutate(target.id, { onError: () => fail('Could not delete project') });
  }, [deleteMutation, deleteTarget, fail]);

  const projectActions: RoseProjectActions = {
    onCreateAgentInProject,
    onOpenProjectSettings: toggleProjectSettings,
    onStartRename: (project) => setRenamingProjectId(project.id),
    onCancelRename: () => setRenamingProjectId(null),
    onRename: (project, name) => {
      setRenamingProjectId(null);
      if (name === project.name) return;
      updateMutation.mutate(
        { id: project.id, updates: { name } },
        { onError: () => fail('Could not rename project') },
      );
    },
    onRequestDelete: setDeleteTarget,
    onCreateProject: async (name) => {
      try {
        await createMutation.mutateAsync(name);
        return null;
      } catch (err) {
        if (err instanceof DuplicateProjectNameError) return err.message;
        fail('Could not create project');
        return 'Could not create project. Try again.';
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
