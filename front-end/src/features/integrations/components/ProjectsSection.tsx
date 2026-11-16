/**
 * STATE MACHINE: ProjectsSection (Integrations › GitHub Repositories; Andy, 2026-11-15)
 *
 *   A project and a GitHub repo are one thing. Code agents are not created inside
 *   a project: the root agent picks the repository a code agent starts in (its
 *   checkout, .env files and startup script). Rows use the panel's row look.
 *
 *   rows: one per repository (useIntegrationProjects: GET /api/projects rows with
 *     isRepository; left-bar folders are filtered out)
 *     icon  GitHub owner avatar (glows: connected) | laptop (imported, no GitHub)
 *     name  + detail "owner/repo · main · 6 env files · synced 2h ago"
 *           (shared by a teammate: "Shared by <owner> · …", no ⚙: read-only)
 *     ⚙ --toggle--> [SETTINGS OPEN] the `projectSettings` slot (the apps panel
 *       passes the project settings panel) + "Remove repository"
 *       --Remove repository--> [CONFIRM] --Remove--> [REMOVING] --204--> row gone
 *                                         --Cancel--> [SETTINGS OPEN]
 *   Import from your computer
 *     outside the Rose Mac app (no import bridge) --> "Desktop only" + Download for Mac
 *     in the Mac app --Import--> native folder picker; the app runs the user's own
 *       Codex or Claude Code (whichever is signed in) read-only in that folder to
 *       plan the import, then shows the plan for approval (hooks/useLocalImport +
 *       components/local-import/LocalImportFlow); nothing to copy or paste
 *     [IMPORTING] --Cancel--> run cancelled; --done--> list refetched
 *     each of the user's own GitHub rows the backend lists as shareable (github_repo
 *     by `gh:owner/repo`) shows its team-sharing caption (AccountTeamShare) after its name
 *   GitHub repo --Connect--> [CONNECT OPEN] URL + Connect --201--> [CLOSED]
 *     (the repo is listed as a project) | inline error
 *     the GitHub account the import brought (`rose github import`) shows as a
 *     chip "@login" (code agents clone, push and use gh as it); × --> confirm
 *     dialog --> DELETE /api/projects/github-credential
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Laptop, Loader2, Settings } from 'lucide-react';

import { LocalImportFlow } from '@/components/local-import/LocalImportFlow';
import { AccountTeamShare } from '@/components/teams/TeamSharing';
import { hasLocalImport, useLocalImport } from '@/hooks/useLocalImport';
import { useAccountShares, type AccountShareTarget } from '@/hooks/useTeams';
import type { Project } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import { useIntegrationProjects } from '../hooks/useIntegrationProjects';
import {
  ACTION_CLASSES,
  BADGE_CLASSES,
  DESKTOP_ROW_CLASSES,
  DESKTOP_ROW_NAME_CLASSES,
  DesktopSectionHeader,
} from './DesktopIntegrationRow';
import ConnectedAccountChip from './ConnectedAccountChip';
import DropdownIconFrame from './DropdownIconFrame';
import ProjectIcon from './ProjectIcon';
import RemoveAccountDialog from './RemoveAccountDialog';
import { githubCanonicalRef, githubRepoOwner } from './githubRepoOwner';

export interface ProjectsSectionProps {
  /** Project settings shown under a row's ⚙ (the apps panel passes them in). */
  projectSettings?: (project: Project) => ReactNode;
}

const DETAIL = 'truncate text-[12px] text-muted-foreground';
const QUIET_ACTION =
  'shrink-0 text-[12.5px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50';
const INPUT =
  'h-8 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2.5 text-[13px] outline-none focus:border-foreground/40';

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="!h-[19px] !w-[19px]">
      <path
        fill="#24292f"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
      />
    </svg>
  );
}

function GlyphTile({ children, glow = false }: { children: ReactNode; glow?: boolean }) {
  return (
    <DropdownIconFrame iconScale={100} iconFit="contain" isSynced={glow}>
      <span className="flex items-center justify-center">{children}</span>
    </DropdownIconFrame>
  );
}

function LaptopGlyph() {
  return <Laptop className="!h-[18px] !w-[18px] text-[#3f3f46]" strokeWidth={1.8} />;
}

/** "owner/repo" from a GitHub URL; null for other hosts or none. */
function repoLabel(repoUrl: string | null): string | null {
  const match = /github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(repoUrl ?? '');
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function syncedAgo(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'synced just now';
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  if (hours < 48) return 'synced yesterday';
  return `synced ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function projectDetail(project: Project, now = Date.now()): string {
  const repo = repoLabel(project.repoUrl);
  const parts = project.shared ? [`Shared by ${project.shared.ownerName}`] : [];
  parts.push(repo ?? (project.repoUrl === null ? 'From your computer' : project.repoUrl));
  if (repo !== null) parts.push(project.defaultBranch);
  if (project.envFileCount > 0)
    parts.push(`${project.envFileCount} env file${project.envFileCount === 1 ? '' : 's'}`);
  if (project.sync.lastSyncedAt !== null) parts.push(syncedAgo(project.sync.lastSyncedAt, now));
  return parts.join(' · ');
}

function ProjectRow({
  project,
  open,
  onToggle,
  settings,
  removing,
  onRemove,
  share,
}: {
  project: Project;
  open: boolean;
  onToggle: () => void;
  settings?: ReactNode;
  removing: boolean;
  onRemove: () => void;
  /** Team-sharing caption of the user's own GitHub repo (github_repo by `gh:owner/repo`). */
  share?: AccountShareTarget;
}) {
  const [confirming, setConfirming] = useState(false);
  const github = githubRepoOwner(project.repoUrl) !== null;
  return (
    <div className={DESKTOP_ROW_CLASSES} data-testid={`project-row-${project.id}`}>
      <div className="flex items-center gap-3">
        {github ? (
          <GlyphTile glow>
            <ProjectIcon repoUrl={project.repoUrl} />
          </GlyphTile>
        ) : (
          <GlyphTile>
            <LaptopGlyph />
          </GlyphTile>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className={DESKTOP_ROW_NAME_CLASSES}>{project.name}</span>
            {share && <AccountTeamShare {...share} />}
          </div>
          <span className={DETAIL} data-testid="project-detail">
            {projectDetail(project)}
          </span>
        </div>
        {project.shared == null && (
          <button
            type="button"
            aria-label={`${project.name} settings`}
            aria-expanded={open}
            title={`${project.name} settings`}
            onClick={() => {
              setConfirming(false);
              onToggle();
            }}
            className={cn(
              'shrink-0',
              open
                ? 'text-[#e8507f] dark:text-[#ff7aa2]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Settings className="h-4 w-4" strokeWidth={1.8} />
          </button>
        )}
      </div>
      {open && project.shared == null && (
        <div className="ml-[46px] mt-2 text-[13px]">
          {settings}
          <div className="mt-4 flex items-center gap-3 border-t border-border/60 pt-3">
            {confirming ? (
              <>
                <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
                  Remove {project.name}? Code agents can no longer start in it. Its synced files and
                  env values are deleted from Rose; a GitHub repo stays on GitHub.
                </span>
                <button
                  type="button"
                  onClick={onRemove}
                  disabled={removing}
                  className="shrink-0 text-[12.5px] font-semibold text-destructive hover:opacity-80 disabled:opacity-50"
                >
                  {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Remove'}
                </button>
                <button type="button" onClick={() => setConfirming(false)} className={QUIET_ACTION}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className={QUIET_ACTION}>
                Remove repository
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectGithubStep({
  data,
  onDone,
}: {
  data: ReturnType<typeof useIntegrationProjects>;
  onDone: () => void;
}) {
  const [repoUrl, setRepoUrl] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const url = repoUrl.trim();
    if (url !== '' && (await data.connectGithub(url))) onDone();
  };
  return (
    <form
      aria-label="Connect a GitHub repo"
      onSubmit={(e) => void submit(e)}
      className="ml-[46px] mt-2 flex flex-col gap-2"
    >
      <div className="flex items-center gap-3">
        <input
          aria-label="GitHub repository URL"
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
          autoFocus
          onChange={(e) => {
            setRepoUrl(e.target.value);
            data.clearConnectError();
          }}
          aria-invalid={data.connectError !== null}
          className={INPUT}
        />
        <button
          type="submit"
          aria-label="Connect repository"
          disabled={data.connecting || repoUrl.trim() === ''}
          className={ACTION_CLASSES}
        >
          {data.connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Connect'}
        </button>
      </div>
      {data.connectError !== null ? (
        <p role="alert" className="text-[12px] text-destructive">
          {data.connectError}
        </p>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          Clones the repo only. To bring .env files and uncommitted work too, import it from your
          computer.
        </p>
      )}
    </form>
  );
}

const BUSY_IMPORT = new Set(['picking', 'detecting', 'scanning', 'review', 'applying']);

export default function ProjectsSection({ projectSettings }: ProjectsSectionProps) {
  const [connecting, setConnecting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmGithubRemoval, setConfirmGithubRemoval] = useState(false);
  // The Mac app picks the folder and runs the import; elsewhere it needs the app.
  const desktop = hasLocalImport();
  const data = useIntegrationProjects(true);
  const { shareTarget } = useAccountShares();
  const shareOf = (project: Project) => {
    const ref = project.shared == null ? githubCanonicalRef(project.repoUrl) : null;
    return ref === null ? undefined : shareTarget('github_repo', ref);
  };
  const importFlow = useLocalImport();
  const importing = BUSY_IMPORT.has(importFlow.state.status);
  const { refetch } = data;
  const importDone = importFlow.state.status === 'done';
  useEffect(() => {
    if (importDone) void refetch();
  }, [importDone, refetch]);
  return (
    <section aria-label="GitHub Repositories" data-testid="integrations-projects">
      <DesktopSectionHeader>GitHub Repositories</DesktopSectionHeader>
      {data.loading && (
        <p role="status" className="py-2 text-xs text-muted-foreground">
          Loading repositories…
        </p>
      )}
      {data.listError !== null && (
        <p role="alert" className="py-2 text-xs text-destructive">
          Could not load repositories: {data.listError}
        </p>
      )}
      {data.projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          open={openId === project.id}
          onToggle={() => setOpenId((id) => (id === project.id ? null : project.id))}
          settings={projectSettings?.(project)}
          removing={data.removingId === project.id}
          onRemove={() => data.remove(project.id)}
          share={shareOf(project)}
        />
      ))}
      {data.removeError !== null && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {data.removeError}
        </p>
      )}
      <div className={DESKTOP_ROW_CLASSES}>
        <div className="flex items-center gap-3">
          <GlyphTile>
            <LaptopGlyph />
          </GlyphTile>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={DESKTOP_ROW_NAME_CLASSES}>Import from your computer</span>
            <span className="text-[12px] text-muted-foreground">
              Pulls in your local dev setup: GitHub access, .env files and secrets
            </span>
          </div>
          {desktop ? (
            <button
              type="button"
              aria-label={importing ? 'Cancel import' : 'Import from your computer'}
              onClick={() => (importing ? importFlow.reset() : void importFlow.start())}
              disabled={importFlow.state.status === 'picking'}
              className={importing ? QUIET_ACTION : ACTION_CLASSES}
            >
              {importing ? 'Cancel' : 'Import'}
            </button>
          ) : (
            <span className="flex shrink-0 items-center gap-2">
              <span className={BADGE_CLASSES}>Desktop only</span>
              <a href="/download" className={ACTION_CLASSES}>
                Download for Mac
              </a>
            </span>
          )}
        </div>
        {importFlow.state.status !== 'idle' && (
          <div className="ml-[46px] mt-2">
            <LocalImportFlow flow={importFlow} />
          </div>
        )}
      </div>
      <div className={DESKTOP_ROW_CLASSES}>
        <div className="flex items-center gap-3">
          <GlyphTile>
            <GithubMark />
          </GlyphTile>
          <span className={DESKTOP_ROW_NAME_CLASSES}>GitHub repo</span>
          <button
            type="button"
            aria-expanded={connecting}
            aria-label={connecting ? 'Cancel GitHub connect' : 'Connect GitHub repo'}
            onClick={() => {
              data.clearConnectError();
              setConnecting((open) => !open);
            }}
            className={connecting ? QUIET_ACTION : ACTION_CLASSES}
          >
            {connecting ? 'Cancel' : 'Connect'}
          </button>
        </div>
        {data.githubLogin !== null && (
          <div className="ml-[46px] mt-2 flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1.5" data-testid="github-account">
              <ConnectedAccountChip
                variant="desktop"
                label={`@${data.githubLogin}`}
                tone="synced"
                title="Code agents clone, push and use gh as this account"
                onRemove={() => setConfirmGithubRemoval(true)}
                removeLabel={`Remove GitHub account @${data.githubLogin}`}
                removing={data.removingGithubAccount}
              />
            </div>
            {data.removeGithubAccountError !== null && (
              <p role="alert" className="text-xs text-destructive">
                {data.removeGithubAccountError}
              </p>
            )}
          </div>
        )}
        {connecting && <ConnectGithubStep data={data} onDone={() => setConnecting(false)} />}
      </div>
      <RemoveAccountDialog
        pending={
          confirmGithubRemoval && data.githubLogin !== null
            ? { name: 'github_user_credential', label: `GitHub account @${data.githubLogin}` }
            : null
        }
        onCancel={() => setConfirmGithubRemoval(false)}
        onConfirm={() => {
          setConfirmGithubRemoval(false);
          data.removeGithubAccount();
        }}
      />
    </section>
  );
}
