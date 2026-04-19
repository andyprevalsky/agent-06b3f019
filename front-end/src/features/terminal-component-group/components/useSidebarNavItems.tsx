/**
 * Hook that returns the memoized bottom-nav items for the AppSidebar.
 * Encapsulates the icon/onClick wiring so AppSidebar stays focused on layout.
 */

import { useMemo } from 'react';
import { Network, Plug, Settings as SettingsIcon } from 'lucide-react';
import type { SidebarNavItem, SidebarView } from '../types';

interface UseSidebarNavItemsArgs {
  currentView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  onSelectAgent: (agentId: string | null) => void;
}

export function useSidebarNavItems({
  currentView,
  onViewChange,
  onSelectAgent,
}: UseSidebarNavItemsArgs): SidebarNavItem[] {
  return useMemo(() => {
    const makeHandler = (view: SidebarView) => () => {
      onViewChange(view);
      onSelectAgent(null);
    };
    return [
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
  }, [currentView, onViewChange, onSelectAgent]);
}
