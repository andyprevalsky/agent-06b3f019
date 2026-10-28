/**
 * STATE MACHINE: ProjectMaintenanceSection (Template sync, the Rose version of a
 * boxes.dev Template box's maintenance settings)
 *
 *   Snapshot:  "Last snapshot: <time>" | "None yet"  +  [Snapshot now]
 *   Script:    sync script textarea + timeout (1..480 s), part of the settings draft
 *   Triggers:  Run on a schedule (nightly, next run) · Run when files change on
 *              GitHub (last checked) · [Run now]
 *   Runs:      Recent runs (status, time, log on expand)
 *
 *   [IDLE] --Run now / Snapshot now--> [STARTING] --202--> [RUNNING] (state polled every 3 s)
 *   [STARTING] --409 (already running)--> [RUNNING]
 *   [STARTING] --other failure--> [IDLE] + error
 *   [RUNNING] --server says not running--> [IDLE] (runs and snapshot time refetched)
 *   Run now / Snapshot now are DISABLED (with a reason) while: the draft has unsaved
 *   edits (the server runs the SAVED script), a sync is running, no repository is
 *   set, or (Run now only) there is no sync script.
 *   Run row: [COLLAPSED] --click--> [EXPANDED] (loads the redacted log; polls while RUNNING)
 *
 * A failed run publishes no snapshot: the row says FAILED and "Last snapshot" keeps
 * the previous time. Colours follow the panel (text only, no pills); dark-mode
 * variants on every surface.
 */

import { useState } from 'react';

import {
  MAX_MAINTENANCE_TIMEOUT_S,
  MIN_MAINTENANCE_TIMEOUT_S,
  type MaintenanceMode,
  type MaintenanceRun,
  type Project,
} from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';
import { useMaintenance, useMaintenanceRun, useStartMaintenance } from './useProjects';
import type { ProjectDraft } from './useProjectSettingsForm';

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
const MONO = 'font-mono text-[12px]';
const FIELD_ROW =
  'flex items-center justify-between gap-4 border-b border-[#f0f1f4] dark:border-white/[0.07] py-2.5';
const H3 = 'mb-2 mt-[22px] text-[13px] font-semibold';
const LINK_BUTTON = 'font-semibold disabled:opacity-40';
const STATUS_COLOR: Record<MaintenanceRun['status'], string> = {
  RUNNING: '',
  SUCCEEDED: 'text-[#1a7f4b] dark:text-[#5fd08a]',
  FAILED: 'text-[#e5484d]',
  TIMED_OUT: 'text-[#e5484d]',
};
const STATUS_LABEL: Record<MaintenanceRun['status'], string> = {
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  TIMED_OUT: 'Timed out',
};
const TRIGGER_LABEL: Record<MaintenanceRun['trigger'], string> = {
  manual: 'Run now',
  snapshot: 'Snapshot now',
  nightly: 'Nightly',
  github: 'GitHub change',
};

type SetField = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => void;

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function duration(ms: number | null): string {
  if (ms === null) return '';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function Toggle({
  label,
  on,
  onToggle,
  detail,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  detail: string | null;
}) {
  return (
    <div className={FIELD_ROW}>
      <span>{label}</span>
      <span className="flex items-center gap-3">
        {detail !== null && <span className={cn(MONO, MUTED)}>{detail}</span>}
        <button
          type="button"
          aria-label={label}
          aria-pressed={on}
          onClick={onToggle}
          className={MONO}
          style={on ? { color: ROSE_ACTIVE_COLOR } : undefined}
        >
          {on ? 'on' : 'off'}
        </button>
      </span>
    </div>
  );
}

function RunRow({ projectId, run }: { projectId: string; run: MaintenanceRun }) {
  const [open, setOpen] = useState(false);
  const detail = useMaintenanceRun(projectId, open ? run.id : null, run.status === 'RUNNING');
  const shown = detail.data ?? run;
  return (
    <li
      className="border-b border-[#f0f1f4] dark:border-white/[0.07] py-2"
      data-testid="maintenance-run"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className={cn('font-semibold', STATUS_COLOR[run.status])}>
          {STATUS_LABEL[run.status]}
        </span>
        <span className={cn(MONO, MUTED)}>
          {TRIGGER_LABEL[run.trigger]} · {when(run.startedAt)}
          {run.durationMs !== null ? ` · ${duration(run.durationMs)}` : ''}
        </span>
      </button>
      {open && (
        <div className="mt-2">
          {shown.error !== null && (
            <p className="mb-1 text-[#e5484d]" data-testid="maintenance-run-error">
              {shown.error}
            </p>
          )}
          <pre
            aria-label="Run log"
            className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[10px] border border-[#eef0f3] dark:border-white/[0.09] bg-[#fafafb] dark:bg-[#2f2f2c] px-3 py-2 font-mono text-[11px] leading-[1.5] text-slate-700 dark:text-[#ecece8]"
          >
            {detail.isPending ? 'Loading…' : shown.log || 'No output.'}
          </pre>
        </div>
      )}
    </li>
  );
}

export function ProjectMaintenanceSection({
  project,
  draft,
  setField,
  isSyncTimeoutValid,
  isDirty,
}: {
  project: Project;
  draft: ProjectDraft;
  setField: SetField;
  isSyncTimeoutValid: boolean;
  isDirty: boolean;
}) {
  const state = useMaintenance(project.id);
  const start = useStartMaintenance(project.id);
  const [error, setError] = useState<string | null>(null);
  const running = state.data?.running ?? project.maintenance.running;
  const snapshot = state.data?.snapshot ?? project.snapshot;
  const nextRunAt = project.maintenance.nextRunAt;
  const hasScript = (project.maintenance.script ?? '').trim() !== '';
  const blocked = isDirty
    ? 'Save your changes first: a sync runs the saved script.'
    : running || start.isPending
      ? 'A sync is running.'
      : project.repoUrl === null
        ? 'Set a code repository first.'
        : null;
  const runBlocked = blocked ?? (hasScript ? null : 'Add a sync script first.');

  const launch = (mode: MaintenanceMode) => {
    setError(null);
    start.mutate(mode, {
      onError: (e) => {
        // A 409 means a sync is already running: the refetch shows it.
        if (e.name !== 'MaintenanceRunningError') setError(e.message);
      },
    });
  };

  return (
    <section aria-label="Template sync">
      <h3 className={H3}>Template sync</h3>
      <p className={MUTED}>
        Runs on this project&apos;s template sandbox. When it succeeds, Rose snapshots the sandbox
        and new code sessions start from the latest snapshot with dependencies installed.
      </p>

      <div className={FIELD_ROW}>
        <span>Last snapshot</span>
        <span className="flex items-center gap-3">
          <span data-testid="project-last-snapshot" className={MONO}>
            {snapshot === null ? (
              'None yet'
            ) : (
              <time dateTime={snapshot.takenAt}>{when(snapshot.takenAt)}</time>
            )}
          </span>
          <button
            type="button"
            disabled={blocked !== null}
            title={blocked ?? 'Re-snapshot with the latest code, without running the script'}
            onClick={() => launch('snapshot')}
            className={LINK_BUTTON}
            style={{ color: ROSE_ACTIVE_COLOR }}
          >
            Snapshot now
          </button>
        </span>
      </div>

      <textarea
        aria-label="Sync script"
        value={draft.syncScript}
        spellCheck={false}
        rows={10}
        onChange={(e) => setField('syncScript', e.target.value)}
        className="mt-3 w-full resize-y rounded-[10px] border border-[#eef0f3] dark:border-white/[0.09] bg-[#fafafb] dark:bg-[#2f2f2c] px-3.5 py-3 font-mono text-[11.5px] leading-[1.55] text-slate-700 dark:text-[#ecece8] outline-none"
      />
      <label className={FIELD_ROW}>
        <span>Sync timeout</span>
        <span className="flex items-center gap-1">
          <input
            aria-label="Sync timeout (seconds)"
            type="number"
            min={MIN_MAINTENANCE_TIMEOUT_S}
            max={MAX_MAINTENANCE_TIMEOUT_S}
            aria-invalid={!isSyncTimeoutValid}
            value={draft.syncTimeoutS}
            onChange={(e) => setField('syncTimeoutS', Number(e.target.value))}
            className={cn(MONO, 'w-16 bg-transparent text-right outline-none')}
          />
          <span className={MONO}>s</span>
        </span>
      </label>
      {!isSyncTimeoutValid && (
        <p data-testid="project-sync-timeout-error" className="mt-1 text-right text-[#e5484d]">
          Use {MIN_MAINTENANCE_TIMEOUT_S}–{MAX_MAINTENANCE_TIMEOUT_S} seconds (up to 8 minutes)
        </p>
      )}

      <Toggle
        label="Run on a schedule"
        on={draft.syncNightly}
        onToggle={() => setField('syncNightly', !draft.syncNightly)}
        detail={
          draft.syncNightly
            ? nextRunAt !== null
              ? `Nightly · next run ${when(nextRunAt)}`
              : 'Nightly · after you save'
            : null
        }
      />
      <Toggle
        label="Run when files change on GitHub"
        on={draft.syncOnGithubChange}
        onToggle={() => setField('syncOnGithubChange', !draft.syncOnGithubChange)}
        detail={
          draft.syncOnGithubChange
            ? `${project.defaultBranch} · ${
                state.data?.watchCheckedAt
                  ? `checked ${when(state.data.watchCheckedAt)}`
                  : 'not checked yet'
              }`
            : null
        }
      />
      <div className={FIELD_ROW}>
        <span>Run the sync script now</span>
        <span className="flex items-center gap-3">
          {running && (
            <span
              data-testid="maintenance-running"
              className={MONO}
              style={{ color: ROSE_ACTIVE_COLOR }}
            >
              Running…
            </span>
          )}
          <button
            type="button"
            disabled={runBlocked !== null}
            title={runBlocked ?? 'Run the saved sync script on the template sandbox'}
            onClick={() => launch('sync')}
            className={LINK_BUTTON}
            style={{ color: ROSE_ACTIVE_COLOR }}
          >
            Run now
          </button>
        </span>
      </div>
      {error !== null && (
        <p role="alert" className="mt-1 text-right text-[#e5484d]">
          {error}
        </p>
      )}

      <h3 className={H3}>Recent runs</h3>
      {state.data === undefined || state.data.runs.length === 0 ? (
        <p className={MUTED}>No runs yet.</p>
      ) : (
        <ul aria-label="Recent runs">
          {state.data.runs.map((run) => (
            <RunRow key={run.id} projectId={project.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}
