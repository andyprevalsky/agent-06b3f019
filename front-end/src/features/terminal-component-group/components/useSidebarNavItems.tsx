/**
 * Hook that returns the memoized bottom-nav items for the AppSidebar.
 * Encapsulates the icon/onClick wiring so AppSidebar stays focused on layout.
 */

import { useMemo } from 'react';
import {
  Activity,
  Users,
  FlaskConical,
  Globe,
  Network,
  Plug,
  Settings as SettingsIcon,
} from 'lucide-react';
import type { SidebarNavItem, SidebarView } from '../types';

interface UseSidebarNavItemsArgs {
  currentView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  onSelectAgent: (agentId: string | null) => void;
  showBrowse: boolean;
  showBenchmarks: boolean;
  showAdminHealth: boolean;
}

export function useSidebarNavItems({
  currentView,
  onViewChange,
  onSelectAgent,
  showBrowse,
  showBenchmarks,
  showAdminHealth,
}: UseSidebarNavItemsArgs): SidebarNavItem[] {
  return useMemo(() => {
    const makeHandler = (view: SidebarView) => () => {
      onViewChange(view);
      onSelectAgent(null);
    };
    return [
      ...(showBrowse
        ? [
            {
              id: 'browse',
              label: 'Browse',
              icon: <Globe className="h-4 w-4" />,
              onClick: makeHandler('browse'),
              isActive: currentView === 'browse',
            },
          ]
        : []),
      // Benchmarks sits below the Feedback button and above Integrations —
      // internal-team only (admin allowlist or dev mode).
      ...(showBenchmarks
        ? [
            {
              id: 'benchmarks',
              label: 'Benchmarks',
              icon: <FlaskConical className="h-4 w-4" />,
              onClick: makeHandler('benchmarks'),
              isActive: currentView === 'benchmarks',
            },
          ]
        : []),
      ...(showAdminHealth
        ? [
            {
              id: 'admin-health',
              label: 'Health',
              icon: <Activity className="h-4 w-4" />,
              onClick: makeHandler('admin-health'),
              isActive: currentView === 'admin-health',
            },
          ]
        : []),
      {
        id: 'teams',
        label: 'Teams',
        icon: <Users className="h-4 w-4" />,
        onClick: makeHandler('teams'),
        isActive: currentView === 'teams',
      },
      {
        id: 'integrations',
        label: 'Integrations',
        icon: <Plug className="h-4 w-4" />,
        onClick: makeHandler('integrations'),
        isActive: currentView === 'integrations',
      },
      {
        id: 'network',
        label: 'Network',
        icon: <Network className="h-4 w-4" />,
        onClick: makeHandler('network'),
        isActive: currentView === 'network',
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: <SettingsIcon className="h-4 w-4" />,
        onClick: makeHandler('settings'),
        isActive: currentView === 'settings',
      },
    ];
  }, [currentView, onViewChange, onSelectAgent, showBrowse, showBenchmarks, showAdminHealth]);
}
