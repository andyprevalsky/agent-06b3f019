/**
 * Stateless nav button for the AppSidebar bottom section.
 * Delegates tooltip rendering to SidebarTooltip when collapsed.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import SidebarTooltip from './SidebarTooltip';

interface SidebarNavButtonProps {
  icon: ReactNode;
  label: string;
  isActive?: boolean;
  onClick: () => void;
  isCollapsed: boolean;
}

export default function SidebarNavButton({
  icon,
  label,
  isActive,
  onClick,
  isCollapsed,
}: SidebarNavButtonProps) {
  return (
    <SidebarTooltip label={label} isCollapsed={isCollapsed}>
      <button
        onClick={onClick}
        aria-label={label}
        className={cn(
          'w-full flex items-center gap-3 rounded-lg text-sm transition-all duration-200',
          'hover:bg-gray-100 dark:hover:bg-zinc-800',
          isActive && 'bg-gray-100 dark:bg-zinc-800 font-medium',
          isCollapsed ? 'justify-center p-2.5 mx-auto' : 'px-3 py-2.5',
        )}
      >
        <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">{icon}</span>
        {!isCollapsed && <span className="truncate">{label}</span>}
      </button>
    </SidebarTooltip>
  );
}
