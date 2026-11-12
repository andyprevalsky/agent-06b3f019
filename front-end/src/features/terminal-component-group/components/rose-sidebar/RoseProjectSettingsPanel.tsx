/**
 * STATE MACHINE: RoseProjectSettingsPanel (UI ledger rows 19/60)
 *
 *   A project is shown as a Folder (same row and id; lib/api/folders.ts).
 *   Opened from a folder row's ⚙ (or its right-click menu), flush beside the
 *   left bar (LeftPanelShell). Draft/save state lives in useProjectSettingsForm:
 *   [PRISTINE] --edit--> [DIRTY] --Save (PUT edited subset)--> [SAVING] --ok--> [PRISTINE]
 *                                                              --fail--> [DIRTY] + error
 *   [DIRTY] + timeout outside 1..3600 --> [INVALID] inline hint, Save disabled
 *   GitHub repo: read-only (GET /api/folders github_repo); "Connect / Change in
 *   Integrations" opens the Integrations panel, where repos are connected
 *
 * Sections (Rose light styles): GitHub repo (connected repo, read-only, + link
 * to Integrations; default branch, GitHub "Connected"/"Not connected" — never
 * an error — and Last synced)
 * · Set up with your coding agent (copyable one-time setup prompt; its own
 * state machine in ProjectAgentSetupSection) · Startup script · Startup timeout
 * · Template sync (ProjectMaintenanceSection: Last snapshot + Snapshot now, sync
 * script + timeout ≤ 480 s, Run on a schedule, Run when files change on GitHub,
 * Run now, Recent runs) · Environment files (own resource, saved immediately;
 * header count = project.envFileCount) · Lifecycle (Auto-wake, Startup script
 * set/not set).
 */

import { MAX_STARTUP_TIMEOUT_S, MIN_STARTUP_TIMEOUT_S, type Project } from '@/lib/api/projects';
import { GITHUB_REPOS_SECTION_ID, focusIntegrationsSection } from '@/lib/integrationsSection';
import { cn } from '@/lib/utils';

import { useRoseApps } from '../rose-apps/roseAppsState';
import LeftPanelShell from './LeftPanelShell';
import { ProjectAgentSetupSection } from './ProjectAgentSetupSection';
import { ProjectMaintenanceSection } from './ProjectMaintenanceSection';
import { ProjectEnvFilesSection } from './ProjectEnvFilesSection';
import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';
import { useFolderGithubRepo } from './useProjects';
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

/** Opens the Integrations panel at its GitHub Repos section; null outside the apps provider. */
function useOpenIntegrations(): (() => void) | null {
  const apps = useRoseApps();
  if (apps === null) return null;
  return () => {
    if (apps.openApp !== 'integrations') apps.toggleApp('integrations');
    focusIntegrationsSection(GITHUB_REPOS_SECTION_ID);
  };
}

/**
 * Read-only: the folder's connected GitHub repo (GET /api/folders github_repo).
 * Connecting or changing it happens on the Integrations panel, never here.
 */
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
  const folderRepo = useFolderGithubRepo(project.id);
  // While (or if) the folders list cannot load, the project row's repo stands in.
  const repoUrl = folderRepo === undefined ? project.repoUrl : (folderRepo?.repo_url ?? null);
  const openIntegrations = useOpenIntegrations();
  const linkLabel = repoUrl === null ? 'Connect in Integrations' : 'Change in Integrations';
  return (
    <section aria-label="GitHub repo">
      <h3 className={H3}>GitHub repo</h3>
      <div className={FIELD_ROW}>
        <span>Repository</span>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-3">
          <span data-testid="folder-github-repo" className={cn(MONO, 'min-w-0 break-all')}>
            {folderRepo?.canonical_ref ?? repoUrl ?? 'No repository'}
          </span>
          {openIntegrations !== null ? (
            <button
              type="button"
              onClick={openIntegrations}
              className="shrink-0 font-semibold"
              style={{ color: ROSE_ACTIVE_COLOR }}
            >
              {linkLabel}
            </button>
          ) : null}
        </span>
      </div>
      {openIntegrations === null && (
        <p className={MUTED}>Connect or change this folder’s repo on the Integrations panel.</p>
      )}
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
  barExpandedWidth,
  onClose,
  embedded = false,
}: {
  project: Project;
  barExpanded: boolean;
  /** The bar's current expanded width, so the panel sits flush against a dragged bar. */
  barExpandedWidth?: number;
  onClose: () => void;
  embedded?: boolean;
}) {
  const form = useProjectSettingsForm(project);
  const content = (
    <>
      <h2 className="mb-0.5 text-[17px] font-semibold">{project.name}</h2>
      <p className={MUTED}>Folder settings</p>
      <label className={FIELD_ROW}>
        <span>Folder name</span>
        <input
          aria-label="Folder name"
          value={form.draft.name}
          onChange={(e) => form.setField('name', e.target.value)}
          className="min-w-0 bg-transparent text-right outline-none"
        />
      </label>
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
    </>
  );
  return embedded ? (
    <div data-testid="project-settings-content">{content}</div>
  ) : (
    <LeftPanelShell
      label="Folder settings"
      testId="rose-project-settings"
      barExpanded={barExpanded}
      barExpandedWidth={barExpandedWidth}
      onClose={onClose}
    >
      {content}
    </LeftPanelShell>
  );
}
