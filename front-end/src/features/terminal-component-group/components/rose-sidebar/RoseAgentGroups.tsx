/**
 * STATE MACHINE: RoseAgentGroups (Rose Desktop left bar, UI ledger rows 57/60)
 *
 * Project/Home collapse preferences persist locally; folder order is server-owned.
 *
 * EXPANDED (bar hovered) — "+ New folder" first, right under Back | Search,
 * then the created projects, the Home project last (Andy, 2026-10-28); a thin
 * divider line separates consecutive groups:
 *   + New project  (inline: Enter creates, Escape cancels)
 *   [icon] Project A   [+ new agent here] [⚙ settings]   (right-click: rename/settings/delete)
 *       project A agents (indented)
 *       folder rows (one level; collapse/expand, count, +, rename/delete menu)
 *         folder agents; folder-plus on project opens the create editor
 *   ──────
 *   [icon] Project B   [+] [⚙]
 *   (icon = GitHub repo owner's avatar when connected to a GitHub repo, else folder)
 *       ...
 *   ──────
 *   [⌂] Home   [+ new agent in Home]     (every agent without a project)
 *       Home agents
 *
 * COLLAPSED (64px rail): per group the project icon, then its agent icons, then
 * an 18×3px neutral line pill before the next group; Home last. "New folder"
 * keeps its folder-plus icon in the same top slot (label faded), so expanding
 * never shifts the rows below.
 *
 * PENDING NEW-AGENT TARGET (pendingGroupKey, owned by RoseSidebar): the project
 * id (or "home") whose "+" was clicked. Destination routing remains tracked;
 * the desktop composer names it without highlighting the project icon.
 *
 * OLD AGENTS (Andy, 2026-10-26; oldAgents.ts): per group (Home and each
 * project), finished agents last active more than 4 days ago (never pinned,
 * selected, paused/needs-help or running) are hidden behind one quiet row at
 * the bottom of the group, and in the collapsed rail and mobile list too:
 *   [OLD HIDDEN] --"View X old agents"--> [OLD SHOWN] old rows in place, then
 *   [OLD SHOWN]  --"Hide X old agents"--> [OLD HIDDEN]
 * The open set lives in memory only (never persisted); the rail shows no row
 * but follows it. One shared minute clock (useNow) re-evaluates ages; no
 * per-row timers, no fetches. A search query shows every match.
 *
 * AGENT TREES: each root starts closed. A disclosure reveals direct GP children
 * and code sessions owned by that agent; each GP child has its own disclosure.
 * Collapsed rail hides descendants and shows the root's active tree count >1.
 * Only on-screen roots (and the selected root) subscribe to the shared tree.
 * SELECTION: [AGENT] the selected agent row is marked (color/weight)
 *   --code-agent row click--> [CODE AGENT] that row is marked instead; its
 *   owner agent row (still the selected agent underneath) is not.
 *
 * While a search query is active, groups (Home included) with no matching agent drop out.
 */

import { Fragment, useState } from 'react';

import type { Project } from '@/lib/api/projects';
import { cn } from '@/lib/utils';
import type { CodeAgentListItem } from '@/lib/api/tree';

import type { Agent } from '../../hooks';
import { useNow } from '../useNow';
import type { GroupedAgents } from './groupAgentsByProject';
import RoseAgentBranch from './RoseAgentBranch';
import RoseProjectFolders from './RoseProjectFolders';
import type { RoseAgentMenuActions } from './RoseAgentRowMenu';
import RoseProjectRow, { HomeProjectRow, NewProjectRow } from './RoseProjectRow';
import { oldAgentsLabel, splitOldAgents } from './oldAgents';

const OLD_AGENT_CLOCK_MS = 60_000;

export const HOME_GROUP = 'home';

export interface RoseProjectActions {
  onCreateAgentInProject: (project: Project, folderId?: string | null) => void;
  /** "+" on the Home project row (a new agent without a project). */
  onCreateHomeAgent?: () => void;
  onOpenProjectSettings: (project: Project) => void;
  onStartRename: (project: Project) => void;
  onRename: (project: Project, name: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (project: Project) => void;
  /** Resolves to an inline error for the "+ New folder" input (409), else null. */
  onCreateProject: (name: string) => Promise<string | null>;
}

export interface RoseAgentGroupsProps {
  grouped: GroupedAgents;
  mobile?: boolean;
  projectLoading?: boolean;
  projectError?: boolean;
  onRetryProjects?: () => void;
  isExpanded: boolean;
  isFiltering: boolean;
  selectedAgentId: string | null;
  attentionAgentIds: ReadonlySet<string>;
  /** Project whose settings panel is open (its row shows as active). */
  settingsProjectId: string | null;
  renamingProjectId: string | null;
  /** Group (project id or HOME_GROUP) the next new agent is created in, if marked. */
  pendingGroupKey?: string | null;
  onSelectAgent: (agentId: string) => void;
  /** `root` is the top-level agent that owns `agent` (sub-agent rows move their root). */
  actionsFor: (agent: Agent, root?: Agent) => RoseAgentMenuActions;
  onMenuOpenChange: (open: boolean) => void;
  projectActions: RoseProjectActions;
  /** Code agents listed under an agent row (its tree's sessions). */
  codeAgentsFor: (agentId: string) => readonly CodeAgentListItem[];
  onOpenCodeAgent: (codeAgent: CodeAgentListItem) => void;
  /** The code agent whose conversation is open (its row is marked, not its owner's). */
  selectedCodeAgentId: string | null;
  /** Ref for each agent row; its visibility decides which code-agent pages are read. */
  observeRoot: (agentId: string) => (element: HTMLElement | null) => void;
  visibleRootIds?: ReadonlySet<string>;
}

function GroupDivider({ isExpanded }: { isExpanded: boolean }) {
  return (
    <div
      data-testid="rose-group-divider"
      aria-hidden="true"
      className={cn('flex flex-none justify-center', isExpanded ? 'px-[22px] py-1.5' : 'py-2')}
    >
      <i
        className={cn(
          'block bg-[hsl(240_6%_86%)] dark:bg-white/[0.07]',
          isExpanded ? 'h-px w-full' : 'h-[3px] w-[18px] rounded-[3px]',
        )}
      />
    </div>
  );
}

function AgentRows({
  agents,
  indented,
  props,
}: {
  agents: Agent[];
  indented: boolean;
  props: RoseAgentGroupsProps;
}) {
  return (
    <>
      {agents.map((agent) => (
        <RoseAgentBranch
          key={agent.agent_id}
          agent={agent}
          indented={indented}
          mobile={props.mobile}
          sidebar={props}
        />
      ))}
    </>
  );
}

function ProjectGroupRow({
  project,
  agents,
  props,
  renderAgents,
  open,
  onToggle,
  onExpand,
}: {
  project: Project;
  agents: Agent[];
  props: RoseAgentGroupsProps;
  renderAgents: (agents: Agent[], key: string) => React.ReactNode;
  open: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const [creatingFolder, setCreatingFolder] = useState(false);
  const a = props.projectActions;
  const isActive =
    props.settingsProjectId === project.id ||
    agents.some((agent) => agent.agent_id === props.selectedAgentId);
  return (
    <>
      <RoseProjectRow
        project={project}
        isActive={isActive}
        isRenaming={props.renamingProjectId === project.id}
        isExpanded={props.isExpanded}
        isPending={props.pendingGroupKey === project.id}
        contentsOpen={open}
        contentsToggleDisabled={props.isFiltering}
        onToggleContents={onToggle}
        onCreateAgent={() => a.onCreateAgentInProject(project)}
        onCreateFolder={() => {
          onExpand();
          setCreatingFolder(true);
        }}
        onOpenSettings={() => a.onOpenProjectSettings(project)}
        onStartRename={() => a.onStartRename(project)}
        onRename={(name) => a.onRename(project, name)}
        onCancelRename={a.onCancelRename}
        onRequestDelete={() => a.onRequestDelete(project)}
        onMenuOpenChange={props.onMenuOpenChange}
      />
      <div
        id={`rose-project-group-${project.id}`}
        data-testid={`rose-group-${project.id}`}
        hidden={!open}
        className={open ? 'flex flex-col' : undefined}
      >
        <RoseProjectFolders
          project={project}
          agents={agents}
          creating={creatingFolder}
          onCancelCreate={() => setCreatingFolder(false)}
          expanded={props.isExpanded}
          filtering={props.isFiltering}
          selectedAgentId={props.selectedAgentId}
          pendingGroupKey={props.pendingGroupKey}
          onCreateAgent={a.onCreateAgentInProject}
          onMenuOpenChange={props.onMenuOpenChange}
          renderAgents={renderAgents}
        />
      </div>
    </>
  );
}

function OldAgentsToggle({
  count,
  open,
  indented,
  onToggle,
}: {
  count: number;
  open: boolean;
  indented: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'flex h-[30px] flex-none items-center whitespace-nowrap text-left text-[13px] text-[hsl(240_8%_45%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_8%)] dark:hover:text-[#ecece8]',
        indented ? 'pl-[66px]' : 'pl-[54px]',
      )}
    >
      {oldAgentsLabel(count, open)}
    </button>
  );
}

interface GroupView {
  key: string;
  agents: Agent[];
  old: Agent[];
  /** Rows on screen: recent agents, plus the old ones while the group is open. */
  shown: Agent[];
}

function GroupAgents({
  view,
  indented,
  open,
  onToggle,
  props,
}: {
  view: GroupView;
  indented: boolean;
  open: boolean;
  onToggle: () => void;
  props: RoseAgentGroupsProps;
}) {
  return (
    <>
      <AgentRows agents={view.shown} indented={indented} props={props} />
      {props.isExpanded && view.old.length > 0 && (
        <OldAgentsToggle
          count={view.old.length}
          open={open}
          indented={indented}
          onToggle={onToggle}
        />
      )}
    </>
  );
}

export default function RoseAgentGroups(props: RoseAgentGroupsProps) {
  const { grouped, isExpanded, isFiltering } = props;
  const now = useNow(OLD_AGENT_CLOCK_MS, true);
  const [openOld, setOpenOld] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('rose:collapsed-projects') ?? '[]');
      return new Set(
        Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [],
      );
    } catch {
      return new Set<string>();
    }
  });
  const setProjectOpen = (key: string, open: boolean) => {
    const next = new Set(collapsedProjects);
    if (open) next.delete(key);
    else next.add(key);
    setCollapsedProjects(next);
    try {
      localStorage.setItem('rose:collapsed-projects', JSON.stringify([...next]));
    } catch {
      /* Collapsing still works when browser storage is unavailable. */
    }
  };
  const toggleOld = (key: string) =>
    setOpenOld((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const viewOf = (key: string, agents: Agent[]): GroupView => {
    if (isFiltering) return { key, agents, old: [], shown: agents };
    const { recent, old } = splitOldAgents(agents, now, props);
    return { key, agents, old, shown: openOld.has(key) ? [...recent, ...old] : recent };
  };
  const projectGroups = isFiltering
    ? grouped.projects.filter((g) => g.agents.length > 0)
    : grouped.projects;
  const projectViews = projectGroups.map((g) => ({
    project: g.project,
    view: viewOf(g.project.id, g.agents),
  }));
  const homeView = viewOf(HOME_GROUP, grouped.home);
  // Like project groups, Home drops out of a search with no Home match.
  const showHome = !isFiltering || homeView.shown.length > 0;
  return (
    <div data-testid="rose-agent-groups" className="flex flex-col">
      {!isFiltering && (
        <NewProjectRow onCreate={props.projectActions.onCreateProject} isExpanded={isExpanded} />
      )}
      {isExpanded && props.projectLoading && (
        <p role="status" className="px-5 py-2 text-xs text-muted-foreground">
          Loading folders…
        </p>
      )}
      {isExpanded && props.projectError && (
        <div role="alert" className="px-5 py-2 text-xs text-destructive">
          Could not load folders.{' '}
          <button type="button" onClick={props.onRetryProjects} className="font-semibold underline">
            Retry folders
          </button>
        </div>
      )}
      {projectViews.map(({ project, view }, index) => (
        <Fragment key={project.id}>
          {index > 0 && <GroupDivider isExpanded={isExpanded} />}
          <ProjectGroupRow
            project={project}
            agents={view.agents}
            props={props}
            open={isFiltering || !collapsedProjects.has(project.id)}
            onToggle={() => setProjectOpen(project.id, collapsedProjects.has(project.id))}
            onExpand={() => setProjectOpen(project.id, true)}
            renderAgents={(agents, key) => (
              <GroupAgents
                view={viewOf(key, agents)}
                indented
                open={openOld.has(key)}
                onToggle={() => toggleOld(key)}
                props={props}
              />
            )}
          />
        </Fragment>
      ))}
      {showHome && projectViews.length > 0 && <GroupDivider isExpanded={isExpanded} />}
      {showHome && (
        <HomeProjectRow
          isExpanded={isExpanded}
          isActive={homeView.agents.some((agent) => agent.agent_id === props.selectedAgentId)}
          isPending={props.pendingGroupKey === HOME_GROUP}
          contentsOpen={isFiltering || !collapsedProjects.has(HOME_GROUP)}
          contentsToggleDisabled={isFiltering}
          onToggleContents={() => setProjectOpen(HOME_GROUP, collapsedProjects.has(HOME_GROUP))}
          onCreateAgent={props.projectActions.onCreateHomeAgent}
        />
      )}
      <div
        id="rose-project-group-home"
        data-testid="rose-group-home"
        hidden={!showHome || (!isFiltering && collapsedProjects.has(HOME_GROUP))}
        className={
          showHome && (isFiltering || !collapsedProjects.has(HOME_GROUP))
            ? 'flex flex-col'
            : undefined
        }
      >
        <GroupAgents
          view={homeView}
          indented
          open={openOld.has(HOME_GROUP)}
          onToggle={() => toggleOld(HOME_GROUP)}
          props={props}
        />
      </div>
    </div>
  );
}
