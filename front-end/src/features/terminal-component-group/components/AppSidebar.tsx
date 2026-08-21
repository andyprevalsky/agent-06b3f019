/**
 * STATE MACHINE: AppSidebar
 *
 * WIDTH STATE (owned by useSidebarWidth, persisted to localStorage):
 * [EXPANDED 220-480px] --drag right edge--> [EXPANDED, new width]
 *          |  ^                                   |
 *          |  |                          drag below 160px
 *          |  +--- drag past 160px --------+      |
 *          v                                      v
 * [COLLAPSED 64px rail] <-------------------------+
 *
 * The old one-click chevron toggle is gone: the rail is sized by dragging its
 * right edge. Selecting admin-health still collapses programmatically because
 * that view renders full-width.
 *
 * ARCHIVE STATE:
 * [CLOSED] --click "Archived"--> [ARCHIVE DIALOG] --close/select--> [CLOSED]
 *
 * LAYOUT INVARIANT:
 * Every desktop surface reserves 3rem above New Agent. The shared sidebar owns
 * that spacing so the web and Electron renderers cannot silently diverge.
 *
 * All other state (agents, selection, credits, feedback popover, subscription
 * modal) is owned either by the parent (agents/view) or by extracted
 * sub-components (SidebarAgentList, SidebarCreditIndicator,
 * SidebarFeedbackButton, SidebarBottomNav). Row mutations (rename/pin/archive)
 * live in useAgentRowActions.
 */

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import type { User } from '@supabase/supabase-js';
import { cn } from '@/lib/utils';
import {
  SidebarArchivedButton,
  SidebarCreateAgentButton,
  SidebarResizeHandle,
  SidebarSearch,
} from './SidebarChrome';
import SidebarAgentList from './SidebarAgentList';
import SidebarBottomNav from './SidebarBottomNav';
import ArchivedAgentsDialog from './ArchivedAgentsDialog';
import { useAgentRowActions } from './useAgentRowActions';
import { useSidebarWidth } from './useSidebarWidth';
import { useSidebarNavItems } from './useSidebarNavItems';
import { useSidebarSearch } from './useSidebarSearch';
import { SIDEBAR_WIDTH_COLLAPSED } from '../config';
import type { Agent } from '../hooks';
import type { SidebarDripStyles, SidebarView } from '../types';

interface AppSidebarProps {
  currentView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  showBrowse?: boolean;
  showBenchmarks?: boolean;
  agents: Agent[];
  isLoadingAgents: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onCreateAgent: () => void;
  /** Reload the agent list after a row mutation (rename/pin/archive/restore). */
  onRefreshAgents: () => void | Promise<void>;
  /**
   * Agent ids blocked on a user answer. Passed in rather than read from context
   * so the sidebar stays fully props-driven (see AttentionRequestsProvider).
   */
  attentionAgentIds?: ReadonlySet<string>;
  user: User | null;
  onLogout: () => void;
  onLoginClick: () => void;
  showAdminHealth?: boolean;
  dripStyles?: SidebarDripStyles;
  blur?: number;
  backgroundColors?: number;
  borderColor?: number;
  shadowIntensity?: number;
}

function buildSidebarStyle({
  width,
  blur,
  backgroundColors,
  borderColor,
  dripStyles,
}: {
  width: number;
  blur: number;
  backgroundColors: number;
  borderColor: number;
  dripStyles?: SidebarDripStyles;
}): CSSProperties {
  const backdrop =
    blur > 0 && dripStyles
      ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
      : 'blur(16px)';

  return {
    width,
    paddingTop: '3rem',
    backdropFilter: backdrop,
    WebkitBackdropFilter: backdrop,
    backgroundColor:
      backgroundColors > 0 && dripStyles
        ? `rgba(255, 255, 255, ${dripStyles.bgOpacity * 0.95})`
        : undefined,
    borderColor: borderColor > 0 && dripStyles ? dripStyles.borderRgb : undefined,
  };
}

/** Memoized inline style for the rail (width + the optional "drip" theming). */
function useSidebarStyle(params: {
  width: number;
  blur: number;
  backgroundColors: number;
  borderColor: number;
  dripStyles?: SidebarDripStyles;
}): CSSProperties {
  const { width, blur, backgroundColors, borderColor, dripStyles } = params;
  return useMemo(
    () => buildSidebarStyle({ width, blur, backgroundColors, borderColor, dripStyles }),
    [width, blur, backgroundColors, borderColor, dripStyles],
  );
}

/** Everything pinned below the agent list: the archive entry point, then nav. */
function SidebarFooter({
  isCollapsed,
  navItems,
  user,
  onLogout,
  onLoginClick,
  onOpenArchive,
}: {
  isCollapsed: boolean;
  navItems: ReturnType<typeof useSidebarNavItems>;
  user: User | null;
  onLogout: () => void;
  onLoginClick: () => void;
  onOpenArchive: () => void;
}) {
  return (
    <>
      <SidebarArchivedButton isCollapsed={isCollapsed} onClick={onOpenArchive} />
      <SidebarBottomNav
        navItems={navItems}
        isCollapsed={isCollapsed}
        user={user}
        onLogout={onLogout}
        onLoginClick={onLoginClick}
      />
    </>
  );
}

/** Admin-health opens full-width, so selecting it also collapses the rail. */
function useCollapsingViewChange(onViewChange: (view: SidebarView) => void, collapse: () => void) {
  return useCallback(
    (view: SidebarView) => {
      onViewChange(view);
      if (view === 'admin-health') collapse();
    },
    [onViewChange, collapse],
  );
}

/**
 * Owns the row mutations + the archive dialog, so AppSidebar itself stays a
 * layout shell. Bumps `archiveRefreshToken` on every mutation because the
 * archive list is fetched separately from the active list.
 */
function useSidebarAgentActions({
  onRefreshAgents,
  selectedAgentId,
  onSelectAgent,
}: {
  onRefreshAgents: () => void | Promise<void>;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
}) {
  const [archiveRefreshToken, setArchiveRefreshToken] = useState(0);

  const refreshAll = useCallback(async () => {
    setArchiveRefreshToken((token) => token + 1);
    await onRefreshAgents();
  }, [onRefreshAgents]);

  const { handlers, renameDialog } = useAgentRowActions({
    onRefresh: refreshAll,
    selectedAgentId,
    onSelectAgent,
  });

  return { handlers, renameDialog, archiveRefreshToken };
}

export default function AppSidebar({
  currentView,
  onViewChange,
  showBrowse = false,
  showBenchmarks = false,
  agents,
  isLoadingAgents,
  selectedAgentId,
  onSelectAgent,
  onCreateAgent,
  onRefreshAgents,
  attentionAgentIds,
  user,
  onLogout,
  onLoginClick,
  showAdminHealth = false,
  dripStyles,
  blur = 0,
  backgroundColors = 0,
  borderColor = 0,
}: AppSidebarProps) {
  const { width, isCollapsed, isDragging, startDrag, setWidth } = useSidebarWidth();
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const search = useSidebarSearch(agents, searchQuery);

  const collapse = useCallback(() => setWidth(SIDEBAR_WIDTH_COLLAPSED), [setWidth]);
  const handleViewChange = useCollapsingViewChange(onViewChange, collapse);

  const { handlers, renameDialog, archiveRefreshToken } = useSidebarAgentActions({
    onRefreshAgents,
    selectedAgentId,
    onSelectAgent,
  });

  const navItems = useSidebarNavItems({
    currentView,
    onViewChange: handleViewChange,
    onSelectAgent,
    showBrowse,
    showBenchmarks,
    showAdminHealth,
  });
  const style = useSidebarStyle({ width, blur, backgroundColors, borderColor, dripStyles });
  const listProps = {
    agents: search.agents,
    isLoadingAgents,
    selectedAgentId,
    onSelectAgent,
    isCollapsed,
    attentionAgentIds,
    query: searchQuery,
    contentMatchAgentIds: search.contentMatchAgentIds,
    isSearching: search.isSearching,
    searchError: search.searchError,
    ...handlers,
  };
  const footerProps = { isCollapsed, navItems, user, onLogout, onLoginClick };
  const archiveProps = { onSelectAgent, handlers, refreshToken: archiveRefreshToken };

  return (
    <aside
      className={cn(
        'group/sidebar fixed top-0 left-0 z-[50] hidden h-full flex-col border-r border-gray-200/60 bg-white/95 md:flex',
        'ease-out shadow-xl',
        // Animating width while dragging fights the pointer and feels laggy.
        isDragging ? '' : 'transition-all duration-300',
      )}
      style={style}
    >
      <SidebarResizeHandle isDragging={isDragging} onPointerDown={startDrag} />
      <SidebarCreateAgentButton isCollapsed={isCollapsed} onCreateAgent={onCreateAgent} />
      <SidebarSearch isCollapsed={isCollapsed} value={searchQuery} onChange={setSearchQuery} />
      <SidebarAgentList {...listProps} />
      <SidebarFooter {...footerProps} onOpenArchive={() => setIsArchiveOpen(true)} />
      {renameDialog}
      <ArchivedAgentsDialog
        open={isArchiveOpen}
        onOpenChange={setIsArchiveOpen}
        {...archiveProps}
      />
    </aside>
  );
}
