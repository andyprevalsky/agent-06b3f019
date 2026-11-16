/**
 * STATE MACHINE: RoseProjectSettingsPanel (UI ledger rows 19/60)
 *
 *   Opened inline under a project row in Integrations › Projects (its ⚙; the
 *   apps panel passes this panel in as that section's settings slot). Draft/save
 *   state lives in useProjectSettingsForm:
 *   [PRISTINE] --edit--> [DIRTY] --Save (PUT edited subset)--> [SAVING] --ok--> [PRISTINE]
 *                                                              --fail--> [DIRTY] + error
 *   [DIRTY] + timeout outside 1..3600 --> [INVALID] inline hint, Save disabled
 *   Repository: read-only (project.repoUrl); a project with no GitHub repo was
 *   imported from the user's computer and restores from its synced checkout.
 *
 * Team sharing uses independent explicit opt-ins through /api/teams.
 *
 * Sections (Rose light styles): Repository (read-only; default branch, GitHub
 * "Connected"/"Not connected" — never an error — and Last synced)
 * · Set up with your coding agent (copyable one-time setup prompt; its own
 * state machine in ProjectAgentSetupSection) · Startup script · Startup timeout
 * · Template sync (ProjectMaintenanceSection: Last snapshot + Snapshot now, sync
 * script + timeout ≤ 480 s, Run on a schedule, Run when files change on GitHub,
 * Run now, Recent runs) · Environment files (own resource, saved immediately;
 * header count = project.envFileCount) · Lifecycle (Auto-wake, Startup script
 * set/not set).
 */

import { ProjectTeamSharing } from '@/components/teams/TeamSharing';

import { MAX_STARTUP_TIMEOUT_S, MIN_STARTUP_TIMEOUT_S, type Project } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import { ProjectAgentSetupSection } from './ProjectAgentSetupSection';
import { ProjectMaintenanceSection } from './ProjectMaintenanceSection';
import { ProjectEnvFilesSection } from './ProjectEnvFilesSection';
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

/** Read-only repository (GitHub URL, or the checkout imported from the user's computer). */
function GithubRepoSection({
  draft,
  setField,
  project,
}: {
  draft: ProjectDraft;
  setField: SetField;
  project: Project;
}) {
  const lastSyncedAt = project.sync.lastSyncedAt;
  return (
    <section aria-label="Repository">
      <h3 className={H3}>Repository</h3>
      <div className={FIELD_ROW}>
        <span>Repository</span>
        <span data-testid="project-repository" className={cn(MONO, 'min-w-0 break-all text-right')}>
          {project.repoUrl ?? 'Imported from your computer'}
        </span>
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

export default function RoseProjectSettingsPanel({ project }: { project: Project }) {
  const form = useProjectSettingsForm(project);
  return (
    <div data-testid="project-settings-content">
      <label className={FIELD_ROW}>
        <span>Project name</span>
        <input
          aria-label="Project name"
          value={form.draft.name}
          onChange={(e) => form.setField('name', e.target.value)}
          className="min-w-0 bg-transparent text-right outline-none"
        />
      </label>
      <ProjectTeamSharing projectId={project.id} />
      <GithubRepoSection draft={form.draft} setField={form.setField} project={project} />
      <ProjectAgentSetupSection projectId={project.id} />
      <StartupSection
        draft={form.draft}
        setField={form.setField}
        isTimeoutValid={form.isTimeoutValid}
      />
      <ProjectMaintenanceSection
        project={project}
        draft={form.draft}
        setField={form.setField}
        isSyncTimeoutValid={form.isSyncTimeoutValid}
        isDirty={form.isDirty}
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
    </div>
  );
}
