/**
 * STATE MACHINE: useProjectSettingsForm
 *
 *   [PRISTINE] --edit any field--> [DIRTY] --save--> [SAVING]
 *   [SAVING] --PATCH ok--> [PRISTINE] (draft re-seeded from the saved project)
 *   [SAVING] --PATCH fails--> [DIRTY] + error message
 *   project prop changes (another project opened) --> [PRISTINE] for that project
 *
 * Holds a local draft of the editable Project fields; `save()` PATCHes only
 * the fields that differ from the loaded project.
 */

import { useCallback, useMemo, useState } from 'react';

import type { Project, ProjectEnvFile, ProjectUpdate } from '@/lib/api/projects';

import { useUpdateProject } from './useProjects';

export type ProjectDraft = Required<ProjectUpdate>;

function draftOf(project: Project): ProjectDraft {
  return {
    name: project.name,
    repoUrl: project.repoUrl ?? null,
    defaultBranch: project.defaultBranch,
    startupScript: project.startupScript,
    startupTimeoutSec: project.startupTimeoutSec,
    envFiles: project.envFiles.map((f) => ({ ...f })),
    autoWake: project.autoWake,
  };
}

function diff(project: Project, draft: ProjectDraft): ProjectUpdate {
  const updates: ProjectUpdate = {};
  if (draft.name !== project.name) updates.name = draft.name;
  if (draft.repoUrl !== (project.repoUrl ?? null)) updates.repoUrl = draft.repoUrl;
  if (draft.defaultBranch !== project.defaultBranch) updates.defaultBranch = draft.defaultBranch;
  if (draft.startupScript !== project.startupScript) updates.startupScript = draft.startupScript;
  if (draft.startupTimeoutSec !== project.startupTimeoutSec)
    updates.startupTimeoutSec = draft.startupTimeoutSec;
  if (draft.autoWake !== project.autoWake) updates.autoWake = draft.autoWake;
  if (JSON.stringify(draft.envFiles) !== JSON.stringify(project.envFiles))
    updates.envFiles = draft.envFiles;
  return updates;
}

export function useProjectSettingsForm(project: Project) {
  const [draft, setDraft] = useState<ProjectDraft>(() => draftOf(project));
  const [error, setError] = useState<string | null>(null);
  const [seededId, setSeededId] = useState(project.id);
  const mutation = useUpdateProject();

  // Re-seed only when another project opens: a background refetch of the same
  // project must not wipe edits in progress.
  if (seededId !== project.id) {
    setSeededId(project.id);
    setDraft(draftOf(project));
    setError(null);
  }

  const updates = useMemo(() => diff(project, draft), [project, draft]);
  const isDirty = Object.keys(updates).length > 0;

  const setField = useCallback(<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setEnvFiles = useCallback((next: (files: ProjectEnvFile[]) => ProjectEnvFile[]) => {
    setDraft((prev) => ({ ...prev, envFiles: next(prev.envFiles) }));
  }, []);

  const save = useCallback(async () => {
    if (!isDirty) return;
    setError(null);
    try {
      const saved = await mutation.mutateAsync({ id: project.id, updates });
      setDraft(draftOf(saved));
    } catch {
      setError('Could not save project settings');
    }
  }, [isDirty, mutation, project.id, updates]);

  return { draft, setField, setEnvFiles, isDirty, isSaving: mutation.isPending, error, save };
}
