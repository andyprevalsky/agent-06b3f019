/**
 * Renders the sidebar's bottom section: credits, feedback, nav items, and login/logout.
 * Purely presentational — all state flows via props.
 */

import type { User } from '@supabase/supabase-js';
import { LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import SidebarCreditIndicator from './SidebarCreditIndicator';
import SidebarFeedbackButton from './SidebarFeedbackButton';
import SidebarNavButton from './SidebarNavButton';
import type { SidebarNavItem } from '../types';

interface SidebarBottomNavProps {
  navItems: SidebarNavItem[];
  isCollapsed: boolean;
  user: User | null;
  onLogout: () => void;
  onLoginClick: () => void;
}

export default function SidebarBottomNav({
  navItems,
  isCollapsed,
  user,
  onLogout,
  onLoginClick,
}: SidebarBottomNavProps) {
  return (
    <>
      <div className="border-t border-gray-200/60 dark:border-zinc-800/60">
        <div className={cn('px-2 py-2', isCollapsed && 'px-1.5')}>
          <SidebarCreditIndicator isCollapsed={isCollapsed} />
        </div>
      </div>

      <div className="border-t border-gray-200/60 dark:border-zinc-800/60">
        <div className={cn('px-2 py-2 space-y-0.5', isCollapsed && 'px-1.5')}>
          <SidebarFeedbackButton isCollapsed={isCollapsed} />
          {navItems.map((item) => (
            <SidebarNavButton
              key={item.id}
              icon={item.icon}
              label={item.label}
              isActive={item.isActive}
              onClick={item.onClick}
              isCollapsed={isCollapsed}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-gray-200/60 dark:border-zinc-800/60">
        <div className={cn('p-2', isCollapsed && 'p-1.5')}>
          {user ? (
            <SidebarNavButton
              icon={<LogOut className="h-4 w-4" />}
              label="Logout"
              onClick={onLogout}
              isCollapsed={isCollapsed}
            />
          ) : (
            <SidebarNavButton
              icon={<LogOut className="h-4 w-4 rotate-180" />}
              label="Login"
              onClick={onLoginClick}
              isCollapsed={isCollapsed}
            />
          )}
        </div>
      </div>
    </>
  );
}
