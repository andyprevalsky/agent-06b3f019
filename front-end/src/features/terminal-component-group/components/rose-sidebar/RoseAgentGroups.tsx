/**
 * STATE MACHINE: RoseAgentGroups (Rose Desktop left bar, UI ledger rows 57/60)
 *
 * Stateless apart from which project row is being renamed (owned by the parent).
 *
 * EXPANDED (bar hovered) — Projects on top (Andy, 2026-10-26), then Home:
 *   [folder] Project A   [+ new agent here] [⚙ settings]   (right-click: rename/settings/delete)
 *       project A agents (indented)
 *   [folder] Project B   [+] [⚙]
 *       ...
 *   + New project  (inline: Enter creates, Escape cancels)
 *   Home agents
 *
 * COLLAPSED (64px rail): project rows and "+ New project" are hidden; the
 * non-empty groups of agent icons are separated by 18×3px neutral line pills.
 *
 * AGENT TREES: each root starts closed. A disclosure reveals direct GP children
 * and code sessions owned by that agent; each GP child has its own disclosure.
 * Collapsed rail hides descendants and shows the root's active tree count >1.
 * Only on-screen roots (and the selected root) subscribe to the shared tree.
 * SELECTION: [AGENT] the selected agent row is marked (color/weight)
 *   --code-agent row click--> [CODE AGENT] that row is marked instead; its
 *   owner agent row (still the selected agent underneath) is not.
 *
 * While a search query is active, project groups with no matching agent drop out.
 */

import { Fragment } from 'react';

import type { Project } from '@/lib/api/projects';
import type { CodeAgentListItem } from '@/lib/api/tree';

import type { Agent } from '../../hooks';
import type { GroupedAgents } from './groupAgentsByProject';
import RoseAgentBranch from './RoseAgentBranch';
import type { RoseAgentMenuActions } from './RoseAgentRowMenu';
import RoseProjectRow, { NewProjectRow } from './RoseProjectRow';

export interface RoseProjectActions {
  onCreateAgentInProject: (project: Project) => void;
  onOpenProjectSettings: (project: Project) => void;
  onStartRename: (project: Project) => void;
  onRename: (project: Project, name: string) => void;
  onCancelRename: () => void;
  onRequestDelete: (project: Project) => void;
  /** Resolves to an inline error for the "+ New project" input (409), else null. */
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
  onSelectAgent: (agentId: string) => void;
  actionsFor: (agent: Agent) => RoseAgentMenuActions;
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

function GroupDivider() {
  return (
    <div data-testid="rose-group-divider" aria-hidden="true" className="flex justify-center py-2">
      <i className="block h-[3px] w-[18px] rounded-[3px] bg-[hsl(240_6%_86%)] dark:bg-white/[0.07]" />
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
}: {
  project: Project;
  agents: Agent[];
  props: RoseAgentGroupsProps;
}) {
  const a = props.projectActions;
  const isActive =
    props.settingsProjectId === project.id ||
    agents.some((agent) => agent.agent_id === props.selectedAgentId);
  return (
    <RoseProjectRow
      project={project}
      isActive={isActive}
      isRenaming={props.renamingProjectId === project.id}
      onCreateAgent={() => a.onCreateAgentInProject(project)}
      onOpenSettings={() => a.onOpenProjectSettings(project)}
      onStartRename={() => a.onStartRename(project)}
      onRename={(name) => a.onRename(project, name)}
      onCancelRename={a.onCancelRename}
      onRequestDelete={() => a.onRequestDelete(project)}
      onMenuOpenChange={props.onMenuOpenChange}
    />
  );
}

export default function RoseAgentGroups(props: RoseAgentGroupsProps) {
  const { grouped, isExpanded, isFiltering } = props;
  const projectGroups = isFiltering
    ? grouped.projects.filter((g) => g.agents.length > 0)
    : grouped.projects;
  const firstAgentGroup =
    projectGroups.find((g) => g.agents.length > 0)?.project.id ??
    (grouped.home.length > 0 ? 'home' : undefined);
  return (
    <div data-testid="rose-agent-groups" className="flex flex-col">
      {isExpanded && props.projectLoading && (
        <p role="status" className="px-5 py-2 text-xs text-muted-foreground">
          Loading projects…
        </p>
      )}
      {isExpanded && props.projectError && (
        <div role="alert" className="px-5 py-2 text-xs text-destructive">
          Could not load projects.{' '}
          <button type="button" onClick={props.onRetryProjects} className="font-semibold underline">
            Retry projects
          </button>
        </div>
      )}
      {projectGroups.map(({ project, agents }) => (
        <Fragment key={project.id}>
          {!isExpanded && agents.length > 0 && firstAgentGroup !== project.id && <GroupDivider />}
          {isExpanded && <ProjectGroupRow project={project} agents={agents} props={props} />}
          <div data-testid={`rose-group-${project.id}`} className="flex flex-col">
            <AgentRows agents={agents} indented props={props} />
          </div>
        </Fragment>
      ))}
      {isExpanded && !isFiltering && (
        <NewProjectRow onCreate={props.projectActions.onCreateProject} />
      )}
      {!isExpanded && grouped.home.length > 0 && firstAgentGroup !== 'home' && <GroupDivider />}
      <div data-testid="rose-group-home" className="flex flex-col">
        <AgentRows agents={grouped.home} indented={false} props={props} />
      </div>
    </div>
  );
}
