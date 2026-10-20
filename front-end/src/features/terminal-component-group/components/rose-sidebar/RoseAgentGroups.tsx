/**
 * STATE MACHINE: RoseAgentGroups (Rose Desktop left bar, UI ledger rows 57/60)
 *
 * Stateless apart from which project row is being renamed (owned by the parent).
 *
 * EXPANDED (bar hovered):
 *   Home agents
 *   [folder] Project A   [+ new agent here] [⚙ settings]   (right-click: rename/settings/delete)
 *       project A agents (indented)
 *   [folder] Project B   [+] [⚙]
 *       ...
 *   + New project  (inline: Enter creates, Escape cancels)
 *
 * COLLAPSED (64px rail): project rows and "+ New project" are hidden; the
 * non-empty groups of agent icons are separated by 18×3px neutral line pills.
 *
 * CODE AGENTS: each agent row is followed by the Claude Code / Codex sessions
 * of its tree (RoseCodeAgentRow), indented one level under it while expanded;
 * collapsed they stay inside the parent's group (no divider between them).
 * Every agent row reports its visibility (observeRoot) so only the trees on
 * screen are read. A running code agent shows the thinking bubble unless it
 * waits on the user (codeAgentsNeedingInput → amber alert instead).
 *
 * While a search query is active, project groups with no matching agent drop out.
 */

import { Fragment } from 'react';

import type { Project } from '@/lib/api/projects';
import type { CodeAgentListItem } from '@/lib/api/tree';

import type { Agent } from '../../hooks';
import type { GroupedAgents } from './groupAgentsByProject';
import RoseAgentRow from './RoseAgentRow';
import RoseCodeAgentRow from './RoseCodeAgentRow';
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
  /** Code agents (task ids) with an unanswered question / approval for the user. */
  codeAgentsNeedingInput: ReadonlySet<string>;
  /** Ref for each agent row; its visibility decides which code-agent pages are read. */
  observeRoot: (agentId: string) => (element: HTMLElement | null) => void;
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
        <Fragment key={agent.agent_id}>
          <RoseAgentRow
            agent={agent}
            isSelected={props.selectedAgentId === agent.agent_id}
            isExpanded={props.isExpanded}
            indented={indented}
            hasAttentionRequest={props.attentionAgentIds.has(agent.agent_id)}
            onClick={() => props.onSelectAgent(agent.agent_id)}
            actions={props.actionsFor(agent)}
            onMenuOpenChange={props.onMenuOpenChange}
            rowRef={props.observeRoot(agent.agent_id)}
          />
          {props.codeAgentsFor(agent.agent_id).map((codeAgent) => (
            <RoseCodeAgentRow
              key={codeAgent.code_agent_id}
              codeAgent={codeAgent}
              isExpanded={props.isExpanded}
              parentIndented={indented}
              needsInput={props.codeAgentsNeedingInput.has(codeAgent.code_agent_id)}
              onOpen={() => props.onOpenCodeAgent(codeAgent)}
            />
          ))}
        </Fragment>
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
    grouped.home.length > 0 ? 'home' : projectGroups.find((g) => g.agents.length > 0)?.project.id;
  return (
    <div data-testid="rose-agent-groups" className="flex flex-col">
      <div data-testid="rose-group-home" className="flex flex-col">
        <AgentRows agents={grouped.home} indented={false} props={props} />
      </div>
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
    </div>
  );
}
