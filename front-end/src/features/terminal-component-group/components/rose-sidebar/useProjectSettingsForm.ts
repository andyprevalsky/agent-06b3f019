/**
 * STATE MACHINE: useProjectSettingsForm
 *
 *   [PRISTINE] --edit any field--> [DIRTY] --save--> [SAVING]
 *   [DIRTY] with startup timeout outside 1..3600 --> [INVALID] (save disabled)
 *   [SAVING] --PUT ok--> [PRISTINE] (draft re-seeded from the saved project)
 *   [SAVING] --PUT fails--> [DIRTY] + error message
 *   project prop changes (another project opened) --> [PRISTINE] for that project
 *
 * Holds a local draft of the editable Project fields; `save()` PUTs only the
 * fields that differ from the loaded project (the server is strict: no unknown
 * or unchanged fields). A cleared startup script is sent as '' (clears it).
 * Environment files are a separate resource (ProjectEnvFilesSection) and are
 * not part of this draft.
 */

import { useCallback, useMemo, useState } from 'react';

import {
  MAX_STARTUP_TIMEOUT_S,
  MIN_STARTUP_TIMEOUT_S,
  type Project,
  type ProjectUpdate,
} from '@/lib/api/projects';

import { useUpdateProject } from './useProjects';

export interface ProjectDraft {
  name: string;
  repoUrl: string | null;
  defaultBranch: string;
  startupScript: string;
  startupTimeoutS: number;
  autoWake: boolean;
}

function draftOf(project: Project): ProjectDraft {
  return {
    name: project.name,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    startupScript: project.startupScript ?? '',
    startupTimeoutS: project.startupTimeoutS,
    autoWake: project.lifecycle.autoWake,
  };
}

function diff(project: Project, draft: ProjectDraft): ProjectUpdate {
  const updates: ProjectUpdate = {};
  if (draft.name !== project.name) updates.name = draft.name;
  if (draft.repoUrl !== project.repoUrl) updates.repoUrl = draft.repoUrl;
  if (draft.defaultBranch !== project.defaultBranch) updates.defaultBranch = draft.defaultBranch;
  if (draft.startupScript !== (project.startupScript ?? ''))
    updates.startupScript = draft.startupScript;
  if (draft.startupTimeoutS !== project.startupTimeoutS)
    updates.startupTimeoutS = draft.startupTimeoutS;
  if (draft.autoWake !== project.lifecycle.autoWake)
    updates.lifecycle = { autoWake: draft.autoWake };
  return updates;
}

export function isValidStartupTimeout(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= MIN_STARTUP_TIMEOUT_S &&
    seconds <= MAX_STARTUP_TIMEOUT_S
  );
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
  const isTimeoutValid = isValidStartupTimeout(draft.startupTimeoutS);

  const setField = useCallback(<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    if (!isDirty || !isTimeoutValid) return;
    setError(null);
    try {
      const saved = await mutation.mutateAsync({ id: project.id, updates });
      setDraft(draftOf(saved));
    } catch {
      setError('Could not save project settings');
    }
  }, [isDirty, isTimeoutValid, mutation, project.id, updates]);

  return {
    draft,
    setField,
    isDirty,
    isTimeoutValid,
    canSave: isDirty && isTimeoutValid && !mutation.isPending,
    isSaving: mutation.isPending,
    error,
    save,
  };
}
