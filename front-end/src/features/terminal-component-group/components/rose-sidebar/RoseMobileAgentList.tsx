/** Mobile shares the desktop project's rows, inline creation, menus and settings. */
import { ArrowLeft, Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Agent } from '../../hooks';
import type { AgentRowHandlers } from '../SidebarAgentList';
import { matchesQuery, sortAgents } from '../agentListOrdering';
import { openCodeAgentFromRow, useCodeAgentView } from '../code-agent-view/codeAgentViewState';
import { useRoseApps } from '../rose-apps/roseAppsState';
import { useRoseAgentMenuActions } from './useRoseAgentMenuActions';
import { useRoseCodeAgents } from './useRoseCodeAgents';
import { useRoseSidebarProjects } from './useRoseSidebarProjects';
import { groupAgentsByProject } from './groupAgentsByProject';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import RoseAgentGroups from './RoseAgentGroups';
import RoseProjectSettingsPanel from './RoseProjectSettingsPanel';

const NO_ATTENTION: ReadonlySet<string> = new Set();
interface MobileAgentListProps {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onClose: () => void;
  handlers: AgentRowHandlers;
  attentionAgentIds?: ReadonlySet<string>;
  query: string;
  contentMatchAgentIds: ReadonlySet<string>;
  isLoading: boolean;
  isSearching: boolean;
  searchError: string | null;
}
function useMobileRows(props: MobileAgentListProps) {
  const attention = props.attentionAgentIds ?? NO_ATTENTION;
  const rows = sortAgents(
    props.agents.filter((a) =>
      matchesQuery(a, props.query.trim().toLowerCase(), props.contentMatchAgentIds),
    ),
    attention,
    false,
  );
  const apps = useRoseApps();
  const projects = useRoseSidebarProjects((project) => {
    apps?.onCreateAgentInProject?.(project);
    props.onClose();
  });
  const code = useRoseCodeAgents(rows, props.selectedAgentId);
  const view = useCodeAgentView();
  const actionsFor = useRoseAgentMenuActions(props.handlers);
  return {
    rows,
    projects,
    sidebar: {
      grouped: groupAgentsByProject(rows, projects.projects),
      mobile: true,
      isExpanded: true,
      isFiltering: Boolean(props.query.trim()),
      selectedAgentId: props.selectedAgentId,
      selectedCodeAgentId: view?.openCodeAgent?.taskId ?? null,
      attentionAgentIds: attention,
      onSelectAgent: props.onSelectAgent,
      actionsFor,
      settingsProjectId: projects.openProject?.id ?? null,
      renamingProjectId: projects.renamingProjectId,
      projectActions: projects.projectActions,
      onMenuOpenChange: () => {},
      ...code,
      projectLoading: projects.projectQuery.isPending,
      projectError: projects.projectQuery.isError,
      onRetryProjects: () => void projects.projectQuery.refetch(),
      onOpenCodeAgent: (row: Parameters<typeof openCodeAgentFromRow>[0]) => {
        if (view) view.open(openCodeAgentFromRow(row));
        else props.onSelectAgent(row.owner_agent_id);
        props.onClose();
      },
    },
  };
}
export function RoseMobileAgentList(props: MobileAgentListProps) {
  const { rows, projects, sidebar } = useMobileRows(props);
  return (
    <ScrollArea className="min-h-0 flex-1 text-foreground">
      <div data-testid="rose-mobile-agent-list" className="py-2">
        {projects.deleteTarget ? (
          <DeleteProjectDialog
            inline
            project={projects.deleteTarget}
            onCancel={projects.cancelDelete}
            onConfirm={projects.confirmDelete}
          />
        ) : projects.openProject ? (
          <div className="px-5 pb-5">
            <button
              type="button"
              onClick={projects.closeProjectSettings}
              className="mb-4 flex items-center gap-2 text-sm font-semibold"
            >
              <ArrowLeft size={16} />
              Back to agents
            </button>
            <RoseProjectSettingsPanel
              key={projects.openProject.id}
              project={projects.openProject}
              barExpanded={false}
              onClose={projects.closeProjectSettings}
              embedded
            />
          </div>
        ) : (
          <>
            {props.searchError && (
              <p role="alert" className="px-5 py-2 text-sm text-destructive">
                {props.searchError}
              </p>
            )}
            {props.isLoading || props.isSearching ? (
              <div className="flex justify-center py-8">
                <Loader2 aria-label="Loading agents" className="h-5 w-5 animate-spin" />
              </div>
            ) : (
              <>
                {rows.length === 0 && (
                  <p className="px-5 py-4 text-center text-sm text-muted-foreground">
                    {props.query ? 'No matching agents' : 'No agents yet'}
                  </p>
                )}
                <RoseAgentGroups {...sidebar} />
              </>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}
