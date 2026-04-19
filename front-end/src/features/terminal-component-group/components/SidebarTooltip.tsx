/**
 * STATE MACHINE: SidebarTooltip
 *
 * [HIDDEN] <-- isHovered: false
 *     |
 *     | (mouseEnter)
 *     v
 * [SHOWN] <-- isHovered: true, only renders tooltip chip if isCollapsed
 *     |
 *     | (mouseLeave)
 *     v
 * [HIDDEN]
 *
 * The tooltip chip only appears when the sidebar is collapsed AND the trigger is hovered.
 * Position is computed against the trigger element's bounding rect.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SIDEBAR_WIDTH_COLLAPSED } from '../config';

interface SidebarTooltipProps {
  children: ReactNode;
  label: string;
  isCollapsed: boolean;
}

export default function SidebarTooltip({ children, label, isCollapsed }: SidebarTooltipProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [position, setPosition] = useState({ top: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isHovered && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({ top: rect.top + rect.height / 2 });
    }
  }, [isHovered]);

  return (
    <div
      ref={triggerRef}
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}

      {isCollapsed && isHovered && (
        <div
          className="fixed z-[100] ml-2 pointer-events-none"
          style={{
            left: SIDEBAR_WIDTH_COLLAPSED,
            top: position.top,
            transform: 'translateY(-50%)',
          }}
        >
          <div className="px-3 py-1.5 rounded-md bg-white dark:bg-zinc-800 shadow-lg border border-gray-200 dark:border-zinc-700 text-sm font-medium whitespace-nowrap animate-in fade-in-0 slide-in-from-left-2 duration-150">
            {label}
          </div>
        </div>
      )}
    </div>
  );
}
