/**
 * STATE MACHINE: RoseSidebar (Rose Desktop left bar; AppSidebar renders it when
 * useRoseDesktop() is true — the stock sidebar is unchanged otherwise)
 *
 * WIDTH (UI ledger row 21, no dragging):
 *   [COLLAPSED 64px] --pointer enters--> [EXPANDED 236px, full titles]
 *   [EXPANDED] --pointer leaves (no open menu, no focused text input)--> [COLLAPSED]
 *   A right-click menu, the search box or an inline name input keeps it EXPANDED.
 *
 * LAYOUT (top → bottom, rows 17/30/57/59/63):
 *   Home (root project) · New Super Agent (black) · Search
 *   agents grouped by project (RoseAgentGroups), each followed by its tree's
 *   code agents (useRoseCodeAgents: one batched read per on-screen page of
 *   ≤50 roots) · + New project
 *   ── Feedback · [Biz health, admins] · Archived · [Browse] · account row.
 *      Feedback, Biz health and the account row (Settings) open in the
 *      right-panel slot (RoseAppsProvider); clicking again closes it.
 *
 * SURFACE: always solid (bg-white / dark #262624), so data-surface="opaque" —
 * legible over a per-user background image without the stock rail's switch.
 * MOBILE (< md): not mounted at all; the mobile agent drawer lists agents.
 *
 * PANELS: project settings beside the bar (useRoseSidebarProjects); archive dialog;
 * rename dialog (useAgentRowActions); delete-project confirm dialog.
 */

import { Activity, Archive, Globe, Megaphone } from 'lucide-react';
import { useState, type FocusEvent } from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/use-mobile';
import type { CodeAgentListItem } from '@/lib/api/tree';
import { cn } from '@/lib/utils';

import type { AppSidebarProps } from '../AppSidebar';
import ArchivedAgentsDialog from '../ArchivedAgentsDialog';
import { matchesQuery, sortAgents } from '../agentListOrdering';
import { useRoseApps } from '../rose-apps/roseAppsState';
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

const NO_ATTENTION: ReadonlySet<string> = new Set<string>();

function useExpansion() {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const isTextInput = (el: EventTarget | null) => el instanceof HTMLInputElement;
  return {
    isExpanded: hovered || menuOpen || typing,
    setMenuOpen,
    surface: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocus: (e: FocusEvent) => setTyping(isTextInput(e.target)),
      onBlur: (e: FocusEvent) => setTyping(isTextInput(e.relatedTarget)),
    },
  };
}

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

/** The bar is md+ only; below md nothing mounts (MobileAgentDrawer owns the list). */
export default function RoseSidebar(props: AppSidebarProps) {
  const isMobile = useIsMobile();
  return isMobile ? null : <RoseSidebarBar {...props} />;
}

function RoseSidebarBar(props: AppSidebarProps) {
  const { onSelectAgent, onViewChange, currentView } = props;
  const apps = useRoseApps();
  const notYet = useNotYet();
  const expansion = useExpansion();
  const [query, setQuery] = useState('');
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [archiveRefreshToken, setArchiveRefreshToken] = useState(0);
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
    onSelectAgent,
  });
  const actionsFor = useRoseAgentMenuActions(handlers, roseActions);
  const { codeAgentsFor, observeRoot } = useRoseCodeAgents(
    [...grouped.home, ...grouped.projects.flatMap((g) => g.agents)],
    props.selectedAgentId,
  );
  const onOpenCodeAgent =
    roseActions.onOpenCodeAgent ??
    ((codeAgent: CodeAgentListItem) => onSelectAgent(codeAgent.owner_agent_id));
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
  return (
    <>
      <aside
        data-testid="rose-sidebar"
        data-expanded={isExpanded}
        data-surface="opaque"
        aria-label="Agents"
        {...expansion.surface}
        className={cn(
          'fixed bottom-0 left-0 top-0 z-[70] hidden flex-col overflow-hidden border-r border-gray-200/70 bg-white pt-3.5 text-[13px] dark:border-white/[0.09] dark:bg-[#262624] md:flex',
          isExpanded && 'shadow-[0_10px_40px_rgba(20,20,40,0.10)]',
        )}
        style={{
          width: isExpanded ? ROSE_BAR_EXPANDED_WIDTH : ROSE_BAR_WIDTH,
          transition: `width ${ROSE_BAR_DURATION_MS}ms ${ROSE_BAR_EASE}`,
        }}
      >
        <RoseHomeRow isExpanded={isExpanded} onClick={props.onCreateAgent} />
        <RoseNewAgentButton isExpanded={isExpanded} onClick={props.onCreateAgent} />
        <RoseSearchRow isExpanded={isExpanded} value={query} onChange={setQuery} />
        {isExpanded && props.userUi?.headerSlot}
        <ScrollArea className="min-h-0 flex-1">
          <RoseAgentGroups
            grouped={grouped}
            isExpanded={isExpanded}
            isFiltering={isFiltering}
            selectedAgentId={props.selectedAgentId}
            attentionAgentIds={attention}
            settingsProjectId={projects.openProject?.id ?? null}
            renamingProjectId={projects.renamingProjectId}
            onSelectAgent={onSelectAgent}
            actionsFor={actionsFor}
            onMenuOpenChange={expansion.setMenuOpen}
            projectActions={projects.projectActions}
            codeAgentsFor={codeAgentsFor}
            onOpenCodeAgent={onOpenCodeAgent}
            observeRoot={observeRoot}
          />
        </ScrollArea>
        {isExpanded && props.userUi?.menuSlot}
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
            isExpanded={isExpanded}
            isActive={apps?.openApp === 'settings'}
            onOpenSettings={() => openPanel('settings')}
            onLoginClick={props.onLoginClick}
          />
        </div>
      </aside>
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
