/**
 * STATE MACHINE: RoseProjectSettingsPanel (UI ledger rows 19/60)
 *
 *   Opened from a project row's ⚙ (or its right-click menu), flush beside the
 *   left bar (LeftPanelShell). Draft/save state lives in useProjectSettingsForm:
 *   [PRISTINE] --edit--> [DIRTY] --Save (PUT edited subset)--> [SAVING] --ok--> [PRISTINE]
 *                                                              --fail--> [DIRTY] + error
 *   [DIRTY] + timeout outside 1..3600 --> [INVALID] inline hint, Save disabled
 *   Code repo: [SHOWING URL] --Change--> [EDITING URL] (saved with Save)
 *
 * Sections (Rose light styles): Code repo (repository URL + Change, default
 * branch, GitHub "Connected"/"Not connected" — never an error — and Last synced)
 * · Startup script · Startup timeout · Environment files (own resource, saved
 * immediately; header count = project.envFileCount) · Lifecycle (Auto-wake,
 * Startup script set/not set).
 */

import { useState } from 'react';

import { MAX_STARTUP_TIMEOUT_S, MIN_STARTUP_TIMEOUT_S, type Project } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import LeftPanelShell from './LeftPanelShell';
import { ProjectEnvFilesSection } from './ProjectEnvFilesSection';
import { ProjectOnboardingSection } from './ProjectOnboardingSection';
import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';
import { useProjectSettingsForm, type ProjectDraft } from './useProjectSettingsForm';

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
const MONO = 'font-mono text-[12px]';
const FIELD_ROW =
  'flex items-center justify-between gap-4 border-b border-[#f0f1f4] dark:border-white/[0.07] py-2.5';
const H3 = 'mb-2 mt-[22px] text-[13px] font-semibold';

type SetField = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => void;

function formatSyncedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function CodeRepoSection({
  draft,
  setField,
  project,
}: {
  draft: ProjectDraft;
  setField: SetField;
  project: Project;
}) {
  const lastSyncedAt = project.sync.lastSyncedAt;
  const [editingUrl, setEditingUrl] = useState(false);
  return (
    <section aria-label="Code repo">
      <h3 className={H3}>Code repo</h3>
      <div className={FIELD_ROW}>
        <span>Repository</span>
        {editingUrl ? (
          <input
            aria-label="Repository URL"
            autoFocus
            value={draft.repoUrl ?? ''}
            placeholder="https://github.com/org/repo"
            onChange={(e) => setField('repoUrl', e.target.value === '' ? null : e.target.value)}
            className={cn(MONO, 'min-w-0 flex-1 bg-transparent text-right outline-none')}
          />
        ) : (
          <span className="flex items-center gap-3">
            <span className={MONO}>{draft.repoUrl ?? 'No repository'}</span>
            <button
              type="button"
              onClick={() => setEditingUrl(true)}
              className="font-semibold"
              style={{ color: ROSE_ACTIVE_COLOR }}
            >
              Change
            </button>
          </span>
        )}
      </div>
      <label className={FIELD_ROW}>
        <span>Default branch</span>
        <input
          aria-label="Default branch"
          value={draft.defaultBranch}
          onChange={(e) => setField('defaultBranch', e.target.value)}
          className={cn(MONO, 'w-40 bg-transparent text-right outline-none')}
        />
      </label>
      <div className={FIELD_ROW}>
        <span>GitHub</span>
        <span data-testid="project-github-status" className={MONO}>
          {project.githubConnected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      <div className={FIELD_ROW}>
        <span>Last synced</span>
        <span data-testid="project-last-synced" className={MONO}>
          {lastSyncedAt === null ? (
            'Never'
          ) : (
            <time dateTime={lastSyncedAt}>{formatSyncedAt(lastSyncedAt)}</time>
          )}
        </span>
      </div>
    </section>
  );
}

function StartupSection({
  draft,
  setField,
  isTimeoutValid,
}: {
  draft: ProjectDraft;
  setField: SetField;
  isTimeoutValid: boolean;
}) {
  return (
    <section aria-label="Startup">
      <h3 className={H3}>Startup script</h3>
      <p className={MUTED}>Runs in every new workspace for this project.</p>
      <textarea
        aria-label="Startup script"
        value={draft.startupScript}
        spellCheck={false}
        rows={10}
        onChange={(e) => setField('startupScript', e.target.value)}
        className="mt-1.5 w-full resize-y rounded-[10px] border border-[#eef0f3] dark:border-white/[0.09] bg-[#fafafb] dark:bg-[#2f2f2c] px-3.5 py-3 font-mono text-[11.5px] leading-[1.55] text-slate-700 dark:text-[#ecece8] outline-none"
      />
      <label className={FIELD_ROW}>
        <span>Startup timeout</span>
        <span className="flex items-center gap-1">
          <input
            aria-label="Startup timeout (seconds)"
            type="number"
            min={MIN_STARTUP_TIMEOUT_S}
            max={MAX_STARTUP_TIMEOUT_S}
            aria-invalid={!isTimeoutValid}
            value={draft.startupTimeoutS}
            onChange={(e) => setField('startupTimeoutS', Number(e.target.value))}
            className={cn(MONO, 'w-16 bg-transparent text-right outline-none')}
          />
          <span className={MONO}>s</span>
        </span>
      </label>
      {!isTimeoutValid && (
        <p data-testid="project-timeout-error" className="mt-1 text-right text-[#e5484d]">
          Use {MIN_STARTUP_TIMEOUT_S}–{MAX_STARTUP_TIMEOUT_S} seconds
        </p>
      )}
    </section>
  );
}

function LifecycleSection({ draft, setField }: { draft: ProjectDraft; setField: SetField }) {
  return (
    <section aria-label="Lifecycle">
      <h3 className={H3}>Lifecycle</h3>
      <div className={FIELD_ROW}>
        <span>Auto-wake</span>
        <button
          type="button"
          aria-label="Auto-wake"
          aria-pressed={draft.autoWake}
          onClick={() => setField('autoWake', !draft.autoWake)}
          className={MONO}
          style={draft.autoWake ? { color: ROSE_ACTIVE_COLOR } : undefined}
        >
          {draft.autoWake ? 'on' : 'off'}
        </button>
      </div>
      <div className={FIELD_ROW}>
        <span>Startup script</span>
        <span className={MONO}>{draft.startupScript.trim() === '' ? 'not set' : 'set'}</span>
      </div>
    </section>
  );
}

export default function RoseProjectSettingsPanel({
  project,
  barExpanded,
  onClose,
}: {
  project: Project;
  barExpanded: boolean;
  onClose: () => void;
}) {
  const form = useProjectSettingsForm(project);
  return (
    <LeftPanelShell
      label="Project settings"
      testId="rose-project-settings"
      barExpanded={barExpanded}
      onClose={onClose}
    >
      <h2 className="mb-0.5 text-[17px] font-semibold">{project.name}</h2>
      <p className={MUTED}>Project settings</p>
      <CodeRepoSection draft={form.draft} setField={form.setField} project={project} />
      <ProjectOnboardingSection project={project} />
      <StartupSection
        draft={form.draft}
        setField={form.setField}
        isTimeoutValid={form.isTimeoutValid}
      />
      <ProjectEnvFilesSection projectId={project.id} envFileCount={project.envFileCount} />
      <LifecycleSection draft={form.draft} setField={form.setField} />
      <div className="mt-6 flex items-center justify-end gap-3">
        {form.error !== null && (
          <span role="alert" className="text-[#e5484d]">
            {form.error}
          </span>
        )}
        <button
          type="button"
          disabled={!form.canSave}
          onClick={() => void form.save()}
          className="h-9 rounded-[10px] bg-[#0a0a0a] px-4 font-semibold text-white disabled:opacity-40"
        >
          {form.isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </LeftPanelShell>
  );
}
