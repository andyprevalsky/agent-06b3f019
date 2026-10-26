/**
 * STATE MACHINE: RoseSidebar (Rose Desktop left bar; AppSidebar renders it when
 * useRoseDesktop() is true — the stock sidebar is unchanged otherwise)
 *
 * WIDTH (UI ledger row 21, no dragging):
 *   [COLLAPSED 64px] --pointer enters--> [EXPANDED 236px, full titles]
 *   [EXPANDED] --pointer leaves (non-Mac, no menu/input)--> [COLLAPSED]
 *   Mac stays expanded after leaving; pointer in the left18% outside controls or a leftward drag collapses it.
 *   A right-click menu, the search box or an inline name input keeps it EXPANDED.
 *
 * LAYOUT (top → bottom, rows 17/30/57/59/63):
 *   Home · New Super Agent (black) · Search
 *   agents grouped by project, with per-agent one-layer disclosures (RoseAgentGroups).
 *   The compact rail shows active tree counts >1; code sessions retain their
 *   provider icons. Code reads stay batched per on-screen page of ≤50 roots.
 *   + New project
 *   ── Feedback · [Biz health, admins] · Archived · [Browse] · account row.
 *      Feedback, Biz health and the account row (Settings) open in the
 *      right-panel slot (RoseAppsProvider); clicking again closes it.
 *      Admins: mounting the bar prewarms Biz health (its code chunk and the
 *      backend's monthly day-cache build) so the panel opens without the wait.
 *
 * SURFACE: always solid (bg-white / dark #262624), so data-surface="opaque".
 * MOBILE (< md): not mounted at all; the mobile agent drawer lists agents.
 *
 * CODE AGENT VIEW (CodeAgentViewProvider, when mounted):
 *   [AGENT] --code-agent row--> [CODE AGENT] its conversation replaces the chat
 *     column (owner selected first when needed); that row is marked, not the owner
 *   [CODE AGENT] --any agent row (incl. its owner)--> [AGENT] that agent; the
 *     owner's row only closes the code agent (no reload); Home / views close it too
 *   No provider (isolated renders): a code-agent row selects its owner agent.
 *
 * PANELS: project settings beside the bar (useRoseSidebarProjects); archive dialog;
 * rename dialog (useAgentRowActions); delete-project confirm dialog.
 *
 * APP VIEW (AppViewProvider; opened from a code-agent chip's preview card): an
 * agent or code-agent row, Home and New Super Agent close it first.
 */

import { ArrowLeft, Activity, Archive, Globe, Megaphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/use-mobile';
import type { CodeAgentListItem } from '@/lib/api/tree';
import { cn } from '@/lib/utils';
import { prewarmAdminHealth } from '@/pages/adminHealthPrewarm';

import type { AppSidebarProps } from '../AppSidebar';
import ArchivedAgentsDialog from '../ArchivedAgentsDialog';
import { matchesQuery, sortAgents } from '../agentListOrdering';
import { openCodeAgentFromRow, useCodeAgentView } from '../code-agent-view/codeAgentViewState';
import { useRoseApps } from '../rose-apps/roseAppsState';
import { useAppView } from '../app-view/appViewState';
import { useAgentRowActions } from '../useAgentRowActions';
import { useSidebarSearch } from '../useSidebarSearch';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import { groupAgentsByProject } from './groupAgentsByProject';
import RoseAgentGroups from './RoseAgentGroups';
import RoseProjectSettingsPanel from './RoseProjectSettingsPanel';
import {
  RoseAccountRow,
  RoseHomeRow,
  RoseNavRow,
  RoseNewAgentButton,
  RoseSearchRow,
} from './RoseSidebarChrome';
import {
  ROSE_BAR_DURATION_MS,
  ROSE_BAR_EASE,
  ROSE_BAR_EXPANDED_WIDTH,
  ROSE_BAR_WIDTH,
} from './roseSidebarLayout';
import { useNotYet, useRoseAgentMenuActions } from './useRoseAgentMenuActions';
import { useRoseCodeAgents } from './useRoseCodeAgents';
import { useRoseSidebarProjects } from './useRoseSidebarProjects';
import { useAccountProfileName } from './useAccountProfileName';

import { useSidebarExpansion } from './useSidebarExpansion';

const NO_ATTENTION: ReadonlySet<string> = new Set<string>();

function useGroupedAgents(
  props: AppSidebarProps,
  query: string,
  projects: Parameters<typeof groupAgentsByProject>[1],
) {
  const search = useSidebarSearch(props.agents, query);
  const needle = query.trim().toLowerCase();
  const attention = props.attentionAgentIds ?? NO_ATTENTION;
  const visible = search.agents.filter((a) => matchesQuery(a, needle, search.contentMatchAgentIds));
  return {
    grouped: groupAgentsByProject(sortAgents(visible, attention, false), projects),
    isFiltering: needle !== '',
    attention,
  };
}

/** Code-agent rows open their own conversation view; agent rows leave it. */
function useCodeAgentRows(props: AppSidebarProps) {
  const { onSelectAgent, selectedAgentId } = props;
  const view = useCodeAgentView();
  const appView = useAppView();
  const openCodeAgent = view?.openCodeAgent ?? null;
  const onOpenCodeAgent = (row: CodeAgentListItem) => {
    appView?.closeApp();
    if (props.roseActions?.onOpenCodeAgent) props.roseActions.onOpenCodeAgent(row);
    else if (view !== null) view.open(openCodeAgentFromRow(row));
    else onSelectAgent(row.owner_agent_id);
  };
  const selectAgentRow = (agentId: string) => {
    appView?.closeApp();
    if (view !== null && openCodeAgent !== null) {
      view.close();
      // The owner is already loaded underneath: closing is enough.
      if (agentId === selectedAgentId) return;
    }
    onSelectAgent(agentId);
  };
  return { onOpenCodeAgent, selectAgentRow, selectedCodeAgentId: openCodeAgent?.taskId ?? null };
}

/** The bar is md+ only; below md nothing mounts (MobileAgentDrawer owns the list). */
export default function RoseSidebar(props: AppSidebarProps) {
  const isMobile = useIsMobile();
  return isMobile ? null : <RoseSidebarBar {...props} />;
}

/** Agent selection and new-agent entry points leave the full-screen app view first. */
function useAppViewExits(props: AppSidebarProps) {
  const appView = useAppView();
  const close = () => appView?.closeApp();
  return {
    close,
    onSelectAgent: (agentId: string | null) => {
      close();
      props.onSelectAgent(agentId);
    },
    onCreateAgent: () => {
      close();
      props.onCreateAgent();
    },
  };
}

function RoseSidebarBar(props: AppSidebarProps) {
  const { onViewChange, currentView } = props;
  const exits = useAppViewExits(props);
  const { onSelectAgent } = exits;
  const apps = useRoseApps();
  const notYet = useNotYet();
  const expansion = useSidebarExpansion();
  const [query, setQuery] = useState('');
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [archiveRefreshToken, setArchiveRefreshToken] = useState(0);
  const showAdminHealth = props.showAdminHealth === true;
  useEffect(() => {
    if (showAdminHealth) prewarmAdminHealth();
  }, [showAdminHealth]);
  const roseActions = props.roseActions ?? {};
  const projects = useRoseSidebarProjects(
    roseActions.onCreateAgentInProject ?? (() => notYet('New agent in a project')),
  );
  const { grouped, isFiltering, attention } = useGroupedAgents(props, query, projects.projects);
  const { handlers, renameDialog } = useAgentRowActions({
    onRefresh: async () => {
      setArchiveRefreshToken((t) => t + 1);
      await props.onRefreshAgents();
    },
    onRefreshAttention: props.onRefreshAttention,
    selectedAgentId: props.selectedAgentId,
    onSelectAgent: props.onSelectAgent,
  });
  const actionsFor = useRoseAgentMenuActions(handlers, roseActions);
  const { codeAgentsFor, observeRoot, visibleRootIds } = useRoseCodeAgents(
    [...grouped.home, ...grouped.projects.flatMap((g) => g.agents)],
    props.selectedAgentId,
  );
  const codeAgentRows = useCodeAgentRows({ ...props, onSelectAgent });
  const goToView = (view: Parameters<typeof onViewChange>[0]) => {
    onViewChange(view);
    onSelectAgent(null);
  };
  const openPanel = (app: 'feedback' | 'health' | 'settings') => {
    if (apps !== null) apps.toggleApp(app);
    else if (app === 'health') goToView('admin-health');
    else if (app === 'settings') goToView('settings');
  };
  const { isExpanded } = expansion;
  const profile = useAccountProfileName(props.user);
  return (
    <>
      {createPortal(
        <aside
          data-testid="rose-sidebar"
          data-expanded={isExpanded}
          data-surface="opaque"
          aria-label="Agents"
          {...expansion.surface}
          className={cn(
            'fixed bottom-0 left-0 top-0 z-[70] hidden flex-col overflow-hidden border-r border-gray-200/70 bg-white pt-3.5 text-[13px] dark:border-white/[0.09] dark:bg-[#262624] md:flex',
            isExpanded && 'z-[110] shadow-[0_10px_40px_rgba(20,20,40,0.10)]',
          )}
          style={{
            width: isExpanded ? ROSE_BAR_EXPANDED_WIDTH : ROSE_BAR_WIDTH,
            transition: `width ${ROSE_BAR_DURATION_MS}ms ${ROSE_BAR_EASE}`,
          }}
        >
          <div className="relative h-[38px] flex-none">
            <RoseHomeRow
              isExpanded={isExpanded}
              onClick={exits.onCreateAgent}
              insetForBackArrow={expansion.sticky && isExpanded}
            />
            {expansion.sticky && isExpanded && (
              <button
                type="button"
                aria-label="Collapse agent sidebar"
                onClick={expansion.close}
                className="absolute left-[22px] top-1/2 -translate-y-1/2 text-muted-foreground"
                data-testid="sidebar-collapse-hint"
              >
                <ArrowLeft className="h-5 w-5" strokeWidth={1.7} />
              </button>
            )}
          </div>
          <RoseNewAgentButton isExpanded={isExpanded} onClick={exits.onCreateAgent} />
          <RoseSearchRow isExpanded={isExpanded} value={query} onChange={setQuery} />
          <ScrollArea className="min-h-0 flex-1">
            <RoseAgentGroups
              grouped={grouped}
              projectLoading={projects.projectQuery.isPending}
              projectError={projects.projectQuery.isError}
              onRetryProjects={() => void projects.projectQuery.refetch()}
              isExpanded={isExpanded}
              isFiltering={isFiltering}
              selectedAgentId={props.selectedAgentId}
              attentionAgentIds={attention}
              settingsProjectId={projects.openProject?.id ?? null}
              renamingProjectId={projects.renamingProjectId}
              onSelectAgent={codeAgentRows.selectAgentRow}
              actionsFor={actionsFor}
              onMenuOpenChange={expansion.setMenuOpen}
              projectActions={projects.projectActions}
              codeAgentsFor={codeAgentsFor}
              onOpenCodeAgent={codeAgentRows.onOpenCodeAgent}
              observeRoot={observeRoot}
              visibleRootIds={visibleRootIds}
              selectedCodeAgentId={codeAgentRows.selectedCodeAgentId}
            />
          </ScrollArea>
          <div className="flex flex-none flex-col pb-2">
            <RoseNavRow
              icon={<Megaphone className="h-5 w-5" strokeWidth={1.7} />}
              label="Feedback"
              isExpanded={isExpanded}
              isActive={apps?.openApp === 'feedback'}
              onClick={() => openPanel('feedback')}
            />
            {props.showAdminHealth === true && (
              <RoseNavRow
                icon={<Activity className="h-5 w-5" strokeWidth={1.7} />}
                label="Biz health"
                isExpanded={isExpanded}
                isActive={apps?.openApp === 'health'}
                onClick={() => openPanel('health')}
              />
            )}
            <RoseNavRow
              icon={<Archive className="h-5 w-5" strokeWidth={1.7} />}
              label="Archived"
              isExpanded={isExpanded}
              onClick={() => setIsArchiveOpen(true)}
            />
            {props.showBrowse === true && (
              <RoseNavRow
                icon={<Globe className="h-5 w-5" strokeWidth={1.7} />}
                label="Browse"
                isExpanded={isExpanded}
                isActive={currentView === 'browse'}
                onClick={() => goToView('browse')}
              />
            )}
            <RoseAccountRow
              user={props.user}
              profileName={profile.name}
              profileLoading={profile.loading}
              isExpanded={isExpanded}
              isActive={apps?.openApp === 'settings'}
              onOpenSettings={() => openPanel('settings')}
              onLoginClick={props.onLoginClick}
            />
          </div>
        </aside>,
        document.body,
      )}
      {projects.openProject !== null && (
        <RoseProjectSettingsPanel
          project={projects.openProject}
          barExpanded={isExpanded}
          onClose={projects.closeProjectSettings}
        />
      )}
      {renameDialog}
      <DeleteProjectDialog
        project={projects.deleteTarget}
        onCancel={projects.cancelDelete}
        onConfirm={projects.confirmDelete}
      />
      <ArchivedAgentsDialog
        open={isArchiveOpen}
        onOpenChange={setIsArchiveOpen}
        onSelectAgent={onSelectAgent}
        handlers={handlers}
        refreshToken={archiveRefreshToken}
      />
    </>
  );
}
