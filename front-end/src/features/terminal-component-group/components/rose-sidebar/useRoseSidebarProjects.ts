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
 * (inline), delete (after the confirm dialog). Failures surface as toasts.
 */

import { useCallback, useState } from 'react';

import { useToast } from '@/hooks/use-toast';
import type { Project } from '@/lib/api/projects';

import { useCreateProject, useDeleteProject, useProjects, useUpdateProject } from './useProjects';
import type { RoseProjectActions } from './RoseAgentGroups';

export function useRoseSidebarProjects(onCreateAgentInProject: (project: Project) => void) {
  const { toast } = useToast();
  const projects = useProjects();
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
    onCreateProject: (name) =>
      createMutation.mutate(name, { onError: () => fail('Could not create project') }),
  };

  const openProject =
    settingsProjectId === null ? null : (projects.find((p) => p.id === settingsProjectId) ?? null);

  return {
    projects,
    openProject,
    closeProjectSettings: () => setSettingsProjectId(null),
    renamingProjectId,
    deleteTarget,
    cancelDelete: () => setDeleteTarget(null),
    confirmDelete,
    projectActions,
  };
}
