/**
 * STATE MACHINE: AppSidebar
 *
 * COLLAPSE STATE:
 * [EXPANDED] <-- isCollapsed: false
 *     |
 *     | (toggle button)
 *     v
 * [COLLAPSED] <-- isCollapsed: true
 *     |
 *     v
 * [EXPANDED]
 *
 * All other state (agents, selection, credits, feedback popover, subscription modal)
 * is owned either by the parent (agents/view) or by extracted sub-components
 * (SidebarAgentList, SidebarCreditIndicator, SidebarFeedbackButton, SidebarBottomNav).
 */

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import SidebarTooltip from './SidebarTooltip';
import SidebarAgentList from './SidebarAgentList';
import SidebarBottomNav from './SidebarBottomNav';
import { useSidebarNavItems } from './useSidebarNavItems';
import { SIDEBAR_WIDTH_COLLAPSED, SIDEBAR_WIDTH_EXPANDED } from '../config';
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
  onResumeAgent: (agentId: string) => Promise<void>;
  resumingAgentId: string | null;
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
    backdropFilter: backdrop,
    WebkitBackdropFilter: backdrop,
    backgroundColor:
      backgroundColors > 0 && dripStyles
        ? `rgba(255, 255, 255, ${dripStyles.bgOpacity * 0.95})`
        : undefined,
    borderColor: borderColor > 0 && dripStyles ? dripStyles.borderRgb : undefined,
  };
}

function SidebarCollapseToggle({
  isCollapsed,
  onToggle,
}: {
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 z-20',
        'w-6 h-6 rounded-full bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700',
        'flex items-center justify-center shadow-md',
        'hover:bg-gray-100 dark:hover:bg-zinc-700 transition-all duration-200',
      )}
      style={{ right: -12 }}
      aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      {isCollapsed ? (
        <ChevronRight className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
      ) : (
        <ChevronLeft className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
      )}
    </button>
  );
}

function SidebarCreateAgentButton({
  isCollapsed,
  onCreateAgent,
}: {
  isCollapsed: boolean;
  onCreateAgent: () => void;
}) {
  return (
    <div className="p-3">
      <SidebarTooltip label="Create Agent" isCollapsed={isCollapsed}>
        <Button
          onClick={onCreateAgent}
          className={cn('w-full transition-all duration-200', isCollapsed && 'px-2')}
          size={isCollapsed ? 'icon' : 'default'}
        >
          <Plus className={cn('h-4 w-4', !isCollapsed && 'mr-2')} />
          <span
            className={cn(
              'transition-all duration-200',
              isCollapsed ? 'w-0 opacity-0 hidden' : 'w-auto opacity-100',
            )}
          >
            Create Agent
          </span>
        </Button>
      </SidebarTooltip>
    </div>
  );
}

/** Admin-health opens full-width, so selecting it also collapses the rail. */
function useCollapsingViewChange(
  onViewChange: (view: SidebarView) => void,
  setIsCollapsed: (collapsed: boolean) => void,
) {
  return useCallback(
    (view: SidebarView) => {
      onViewChange(view);
      if (view === 'admin-health') setIsCollapsed(true);
    },
    [onViewChange, setIsCollapsed],
  );
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
  onResumeAgent,
  resumingAgentId,
  user,
  onLogout,
  onLoginClick,
  showAdminHealth = false,
  dripStyles,
  blur = 0,
  backgroundColors = 0,
  borderColor = 0,
}: AppSidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const currentWidth = isCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;
  const handleViewChange = useCollapsingViewChange(onViewChange, setIsCollapsed);
  const navItems = useSidebarNavItems({
    currentView,
    onViewChange: handleViewChange,
    onSelectAgent,
    showBrowse,
    showBenchmarks,
    showAdminHealth,
  });
  const style = useMemo(
    () =>
      buildSidebarStyle({
        width: currentWidth,
        blur,
        backgroundColors,
        borderColor,
        dripStyles,
      }),
    [currentWidth, blur, backgroundColors, borderColor, dripStyles],
  );

  return (
    <aside
      className={cn(
        'group/sidebar fixed top-0 left-0 h-full hidden md:flex flex-col border-r border-gray-200/60 dark:border-zinc-800/60 bg-white/95 dark:bg-zinc-900/95 z-[50]',
        'transition-all duration-300 ease-out shadow-xl',
      )}
      style={style}
    >
      <SidebarCollapseToggle
        isCollapsed={isCollapsed}
        onToggle={() => setIsCollapsed(!isCollapsed)}
      />
      <SidebarCreateAgentButton isCollapsed={isCollapsed} onCreateAgent={onCreateAgent} />
      <SidebarAgentList
        agents={agents}
        isLoadingAgents={isLoadingAgents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
        onResumeAgent={onResumeAgent}
        resumingAgentId={resumingAgentId}
        isCollapsed={isCollapsed}
      />
      <SidebarBottomNav
        navItems={navItems}
        isCollapsed={isCollapsed}
        user={user}
        onLogout={onLogout}
        onLoginClick={onLoginClick}
      />
    </aside>
  );
}
