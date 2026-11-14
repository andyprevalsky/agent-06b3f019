/**
 * STATE MACHINE: useProjectSettingsForm
 *
 *   [PRISTINE] --edit any field--> [DIRTY] --save--> [SAVING]
 *   [DIRTY] with startup timeout outside 1..3600, or sync timeout outside 1..480
 *     --> [INVALID] (save disabled)
 *   [SAVING] --PUT ok--> [PRISTINE] (draft re-seeded from the saved project)
 *   [SAVING] --PUT fails--> [DIRTY] + error message
 *   project prop changes (another project opened) --> [PRISTINE] for that project
 *
 * Holds a local draft of the editable Project fields (the repo is not one: it is
 * connected or changed on the Integrations panel; a new name saves through
 * PATCH /api/folders/:id, the rest through PUT /api/projects/:id); `save()` PUTs only the
 * fields that differ from the loaded project (the server is strict: no unknown
 * or unchanged fields). A cleared startup script is sent as '' (clears it).
 * The template sync settings (script, timeout, nightly, GitHub watch) are part of
 * the same draft and are sent as one `maintenance` object holding only the
 * changed keys; a cleared sync script is sent as null. Run now / Snapshot now
 * act on the SAVED script, so ProjectMaintenanceSection disables them while
 * the draft is dirty.
 * Environment files are a separate resource (ProjectEnvFilesSection) and are
 * not part of this draft.
 */

import { useCallback, useMemo, useState } from 'react';

import {
  MAX_MAINTENANCE_TIMEOUT_S,
  MAX_STARTUP_TIMEOUT_S,
  MIN_MAINTENANCE_TIMEOUT_S,
  MIN_STARTUP_TIMEOUT_S,
  type Project,
  type ProjectUpdate,
} from '@/lib/api/projects';

import { useUpdateProject } from './useProjects';

export interface ProjectDraft {
  name: string;
  defaultBranch: string;
  startupScript: string;
  startupTimeoutS: number;
  autoWake: boolean;
  syncScript: string;
  syncTimeoutS: number;
  syncNightly: boolean;
  syncOnGithubChange: boolean;
}

function draftOf(project: Project): ProjectDraft {
  return {
    name: project.name,
    defaultBranch: project.defaultBranch,
    startupScript: project.startupScript ?? '',
    startupTimeoutS: project.startupTimeoutS,
    autoWake: project.lifecycle.autoWake,
    syncScript: project.maintenance.script ?? '',
    syncTimeoutS: project.maintenance.timeoutS,
    syncNightly: project.maintenance.nightly,
    syncOnGithubChange: project.maintenance.onGithubChange,
  };
}

function diff(project: Project, draft: ProjectDraft): ProjectUpdate {
  const updates: ProjectUpdate = {};
  if (draft.name !== project.name) updates.name = draft.name;
  if (draft.defaultBranch !== project.defaultBranch) updates.defaultBranch = draft.defaultBranch;
  if (draft.startupScript !== (project.startupScript ?? ''))
    updates.startupScript = draft.startupScript;
  if (draft.startupTimeoutS !== project.startupTimeoutS)
    updates.startupTimeoutS = draft.startupTimeoutS;
  if (draft.autoWake !== project.lifecycle.autoWake)
    updates.lifecycle = { autoWake: draft.autoWake };
  const maintenance = maintenanceDiff(project, draft);
  if (maintenance !== null) updates.maintenance = maintenance;
  return updates;
}

function maintenanceDiff(
  project: Project,
  draft: ProjectDraft,
): ProjectUpdate['maintenance'] | null {
  const current = project.maintenance;
  const changes: NonNullable<ProjectUpdate['maintenance']> = {};
  if (draft.syncScript !== (current.script ?? ''))
    changes.script = draft.syncScript === '' ? null : draft.syncScript;
  if (draft.syncTimeoutS !== current.timeoutS) changes.timeoutS = draft.syncTimeoutS;
  if (draft.syncNightly !== current.nightly) changes.nightly = draft.syncNightly;
  if (draft.syncOnGithubChange !== current.onGithubChange)
    changes.onGithubChange = draft.syncOnGithubChange;
  return Object.keys(changes).length > 0 ? changes : null;
}

export function isValidSyncTimeout(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= MIN_MAINTENANCE_TIMEOUT_S &&
    seconds <= MAX_MAINTENANCE_TIMEOUT_S
  );
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
  const isSyncTimeoutValid = isValidSyncTimeout(draft.syncTimeoutS);

  const setField = useCallback(<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    if (!isDirty || !isTimeoutValid || !isSyncTimeoutValid) return;
    setError(null);
    try {
      const saved = await mutation.mutateAsync({ project, updates });
      setDraft(draftOf(saved));
    } catch {
      setError('Could not save folder settings');
    }
  }, [isDirty, isTimeoutValid, isSyncTimeoutValid, mutation, project, updates]);

  return {
    draft,
    setField,
    isDirty,
    isTimeoutValid,
    isSyncTimeoutValid,
    canSave: isDirty && isTimeoutValid && isSyncTimeoutValid && !mutation.isPending,
    isSaving: mutation.isPending,
    error,
    save,
  };
}
