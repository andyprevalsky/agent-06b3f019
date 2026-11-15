/**
 * STATE MACHINE: GithubReposSection (state in useGithubRepos)
 *
 *   [LOADING] --> [LISTED] connected repos, each with its folder (if any), a
 *     "connected project" (auto-imported, e.g. the Rose repo: no reconnect
 *     needed) or "manual" badge, and ×
 *   folder settings' "Connect / Switch repo in Integrations" --> panel opens scrolled
 *     to this section with that folder pre-selected (lib/integrationsSection.ts):
 *     a folder that has a repo in "Switch a folder's repo", a folder without one
 *     in the connect form's folder picker (once the folders list has loaded)
 *   [LISTED] --Switch repo: folder that has a repo + new repo URL--> [SWITCHING]
 *     (POST replace: true; the old repo stays connected, unassociated)
 *     --ok--> [LISTED] (folder shows the new repo) | --refused--> inline error
 *   [LISTED] --repo URL (+ optional folder) · Connect--> [CONNECTING]
 *     --ok--> [LISTED] (form cleared) | --refused--> [LISTED] + inline error
 *   [LISTED] --× on a repo--> [DISCONNECTING] --done--> [LISTED] | inline error
 *   each repo the backend lists as shareable (github_repo by `gh:owner/repo`) shows its
 *     team-sharing caption (AccountTeamShare) after its badge; this card renders the
 *     same on the stock page and in Rose Desktop
 *
 * Folders never get a repo when they are created; this section is where a repo is
 * connected and, optionally, associated with one folder (its code sessions then
 * check the repo out). Folder settings show that association read-only.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Github, Loader2, Plus, X } from 'lucide-react';

import { AccountTeamShare } from '@/components/teams/TeamSharing';
import { useAccountShares } from '@/hooks/useTeams';

import {
  GITHUB_REPOS_SECTION_ID,
  INTEGRATIONS_SECTION_FOCUS_EVENT,
  takeIntegrationsSectionFocus,
  type IntegrationsSectionFocus,
} from '@/lib/integrationsSection';

import type { useGithubRepos } from '../hooks/useGithubRepos';

interface GithubReposSectionProps {
  github: ReturnType<typeof useGithubRepos>;
}

const NO_FOLDER = '';

/** A folder the panel was asked to focus; `nonce` counts each request. */
interface FolderFocus {
  folderId: string;
  nonce: number;
}

export function GithubReposIcon() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-lg bg-[#24292f] text-white">
      <Github className="h-5 w-5" aria-hidden="true" />
    </div>
  );
}

function detailText(github: GithubReposSectionProps['github']): string {
  if (github.loading) return 'Loading...';
  const count = github.repos.length;
  if (count === 0) return 'Connect repositories your code agents can check out';
  return `${count} repo${count === 1 ? '' : 's'} connected`;
}

function ConnectForm({ github, focus }: GithubReposSectionProps & { focus: FolderFocus | null }) {
  const [repoUrl, setRepoUrl] = useState('');
  const [folderId, setFolderId] = useState(NO_FOLDER);
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    // "Connect in Integrations" from a folder without a repo connects into that folder.
    // Applied once per request, after the folders list has loaded.
    if (focus === null || appliedFocus.current === focus.nonce) return;
    const folder = github.folders.find((candidate) => candidate.id === focus.folderId);
    if (folder === undefined) return;
    appliedFocus.current = focus.nonce;
    if (folder.github_repo === null) setFolderId(folder.id);
  }, [focus, github.folders]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const url = repoUrl.trim();
    if (url === '') return;
    const connected = await github.connect({
      repo_url: url,
      ...(folderId !== NO_FOLDER ? { connected_rose_project_ref: folderId } : {}),
    });
    if (connected) {
      setRepoUrl('');
      setFolderId(NO_FOLDER);
    }
  };
  const inputClass =
    'h-9 min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-foreground/40';
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-2 border-t border-border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="GitHub repository URL"
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
          onChange={(e) => {
            setRepoUrl(e.target.value);
            github.clearConnectError();
          }}
          aria-invalid={github.connectError !== null}
          className={`${inputClass} flex-1`}
        />
        <select
          aria-label="Folder (optional)"
          value={folderId}
          onChange={(e) => {
            setFolderId(e.target.value);
            github.clearConnectError();
          }}
          className={`${inputClass} max-w-[12rem]`}
        >
          <option value={NO_FOLDER}>No folder</option>
          {github.folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          aria-label="Connect GitHub repo"
          disabled={github.connecting || repoUrl.trim() === ''}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-60"
        >
          {github.connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Connect
        </button>
      </div>
      {github.connectError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {github.connectError}
        </p>
      )}
    </form>
  );
}

/** Auto-imported from a project's legacy GitHub connection vs connected on this panel. */
function SourceBadge({ source }: { source: string }) {
  const imported = source === 'legacy_project';
  return (
    <span
      data-testid="github-repo-source"
      title={
        imported
          ? 'Imported from a folder that was already connected to GitHub'
          : 'Connected on this panel'
      }
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        imported
          ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {imported ? 'connected project' : 'manual'}
    </span>
  );
}

/** Switch a folder that already has a repo to another one (connect with replace). */
function SwitchRepoForm({
  github,
  folderId,
  onFolderChange,
}: GithubReposSectionProps & { folderId: string; onFolderChange: (id: string) => void }) {
  const [repoUrl, setRepoUrl] = useState('');
  const withRepo = github.folders.filter((folder) => folder.github_repo !== null);
  const selected = withRepo.find((folder) => folder.id === folderId) ?? null;
  if (withRepo.length === 0) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const url = repoUrl.trim();
    if (selected === null || url === '') return;
    if (await github.switchRepo(selected.id, url)) setRepoUrl('');
  };
  const inputClass =
    'h-9 min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-foreground/40';
  return (
    <form
      aria-label="Switch a folder's repo"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-2 border-t border-border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Folder to switch"
          value={selected?.id ?? NO_FOLDER}
          onChange={(e) => {
            onFolderChange(e.target.value);
            github.clearSwitchError();
          }}
          className={`${inputClass} max-w-[12rem]`}
        >
          <option value={NO_FOLDER}>Switch a folder's repo…</option>
          {withRepo.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        {selected !== null && (
          <>
            <input
              aria-label="New GitHub repository URL"
              placeholder="https://github.com/owner/repo"
              value={repoUrl}
              onChange={(e) => {
                setRepoUrl(e.target.value);
                github.clearSwitchError();
              }}
              aria-invalid={github.switchError !== null}
              className={`${inputClass} flex-1`}
            />
            <button
              type="submit"
              aria-label="Switch repo"
              disabled={github.switching || repoUrl.trim() === ''}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-60"
            >
              {github.switching && <Loader2 className="h-4 w-4 animate-spin" />}
              Switch repo
            </button>
          </>
        )}
      </div>
      {selected?.github_repo != null && (
        <p data-testid="switch-current-repo" className="text-xs text-muted-foreground">
          {selected.name} uses {selected.github_repo.canonical_ref}. Its old repo stays connected.
        </p>
      )}
      {github.switchError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {github.switchError}
        </p>
      )}
    </form>
  );
}

export default function GithubReposSection({ github }: GithubReposSectionProps) {
  const folderName = (id: string | null) =>
    id === null ? null : (github.folders.find((folder) => folder.id === id)?.name ?? null);
  const sectionRef = useRef<HTMLElement>(null);
  const { shareTarget } = useAccountShares();
  const [switchFolderId, setSwitchFolderId] = useState(NO_FOLDER);
  const [folderFocus, setFolderFocus] = useState<FolderFocus | null>(null);
  useEffect(() => {
    const focusFolder = (folderId: string) => {
      setSwitchFolderId(folderId);
      setFolderFocus((previous) => ({ folderId, nonce: (previous?.nonce ?? 0) + 1 }));
    };
    // Folder settings' "Connect / Switch repo in Integrations" opened the panel here.
    const pending = takeIntegrationsSectionFocus(GITHUB_REPOS_SECTION_ID);
    if (pending !== null) {
      sectionRef.current?.scrollIntoView?.({ block: 'start' });
      if (pending.folderId !== null) focusFolder(pending.folderId);
    }
    // ... or asked again while the panel is already open.
    const onFocus = (event: Event) => {
      const focus = (event as CustomEvent<IntegrationsSectionFocus>).detail;
      if (focus.sectionId === GITHUB_REPOS_SECTION_ID && focus.folderId !== null)
        focusFolder(focus.folderId);
    };
    window.addEventListener(INTEGRATIONS_SECTION_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(INTEGRATIONS_SECTION_FOCUS_EVENT, onFocus);
  }, []);
  return (
    <section
      ref={sectionRef}
      id={GITHUB_REPOS_SECTION_ID}
      aria-label="GitHub Repos"
      className="rounded-lg border border-border bg-card/60 overflow-hidden"
    >
      <div className="p-4 flex items-center gap-3">
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg">
          <GithubReposIcon />
        </div>
        <div className="flex min-w-0 flex-col">
          <h3 className="font-medium">GitHub Repos</h3>
          <span className="text-xs text-muted-foreground">{detailText(github)}</span>
          {github.listError !== null && (
            <span role="alert" className="text-xs text-destructive">
              Could not load connected repos: {github.listError}
            </span>
          )}
        </div>
      </div>
      {github.repos.length > 0 && (
        <ul aria-label="Connected GitHub repos" className="border-t border-border">
          {github.repos.map((repo) => {
            const label = `${repo.owner}/${repo.repo_name}`;
            const folder = folderName(repo.connected_rose_project_ref);
            const removing = github.disconnectingRef === repo.canonical_ref;
            const share = shareTarget('github_repo', repo.canonical_ref);
            return (
              <li
                key={repo.canonical_ref}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <div className="flex min-w-0 flex-col">
                  <div className="flex min-w-0 items-center gap-2">
                    <a
                      href={repo.repo_url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-medium hover:underline"
                    >
                      {label}
                    </a>
                    <SourceBadge source={repo.source} />
                    {share && <AccountTeamShare {...share} />}
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {folder !== null ? `Folder: ${folder}` : 'No folder'} · {repo.default_branch}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Disconnect ${label}`}
                  title={`Disconnect ${label}`}
                  onClick={() => github.disconnect(repo.canonical_ref)}
                  disabled={github.disconnectingRef !== null}
                  className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center bg-muted text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  {removing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {github.disconnectError !== null && (
        <p role="alert" className="px-4 pb-2 text-xs text-destructive">
          {github.disconnectError}
        </p>
      )}
      <SwitchRepoForm
        github={github}
        folderId={switchFolderId}
        onFolderChange={setSwitchFolderId}
      />
      <ConnectForm github={github} focus={folderFocus} />
    </section>
  );
}
