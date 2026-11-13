/**
 * Presentational chrome for AppSidebar: the resize handle, the New Agent
 * button, the search box, and the archive entry point.
 *
 * Split out of AppSidebar purely for size — that file is at its max-lines
 * budget. These are stateless; all state lives in AppSidebar.
 */

import { Archive, Plus, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import SidebarTooltip from './SidebarTooltip';

/**
 * Drag target on the sidebar's right edge. Sits in a 3px-wide hit area that
 * widens visually on hover, matching the resize affordance in Cursor/Conductor.
 */
export function SidebarResizeHandle({
  isDragging,
  onPointerDown,
}: {
  isDragging: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
      className={cn(
        'absolute top-0 right-0 h-full w-1.5 translate-x-1/2 z-20 cursor-col-resize',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2',
        'after:transition-colors hover:after:bg-blue-400/60',
        isDragging ? 'after:bg-blue-500' : 'after:bg-transparent',
      )}
    />
  );
}

export function SidebarCreateAgentButton({
  isCollapsed,
  onCreateAgent,
}: {
  isCollapsed: boolean;
  onCreateAgent: () => void;
}) {
  return (
    <div className={cn('pt-2', isCollapsed ? 'px-1.5' : 'px-3')}>
      <SidebarTooltip label="New Agent" isCollapsed={isCollapsed}>
        <button
          type="button"
          aria-label="New Agent"
          onClick={onCreateAgent}
          className={cn(
            'flex w-full items-center rounded-md text-sm font-medium transition-colors',
            isCollapsed
              ? 'h-10 justify-center bg-gray-950 px-2 text-white hover:bg-gray-800'
              : 'h-8 gap-2 px-2 text-gray-700 hover:bg-gray-100 hover:text-gray-950',
          )}
        >
          <Plus className="h-4 w-4" />
          <span className={cn(isCollapsed ? 'hidden w-0 opacity-0' : 'w-auto opacity-100')}>
            New Agent
          </span>
        </button>
      </SidebarTooltip>
    </div>
  );
}

/**
 * Filter box for the agent list.
 *
 * Hidden on the collapsed rail: there is no room for a text field, and the rail
 * is a glanceable strip rather than something you search. Deliberately no
 * keyboard-shortcut badge — advertising a chord we do not bind would be a lie.
 */
export function SidebarSearch({
  isCollapsed,
  value,
  onChange,
}: {
  isCollapsed: boolean;
  value: string;
  onChange: (next: string) => void;
}) {
  if (isCollapsed) return null;
  return (
    <div className="px-3 pt-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search"
          aria-label="Search agents"
          className="h-8 rounded-md border-transparent bg-transparent pl-7 shadow-none hover:bg-gray-100 focus-visible:bg-gray-100 focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>
    </div>
  );
}

/** Entry point to the archive, pinned below the agent list. */
export function SidebarArchivedButton({
  isCollapsed,
  onClick,
}: {
  isCollapsed: boolean;
  onClick: () => void;
}) {
  return (
    <div className={cn('pt-1', isCollapsed ? 'px-1.5' : 'px-3')}>
      <SidebarTooltip label="Archived" isCollapsed={isCollapsed}>
        <button
          onClick={onClick}
          aria-label="Show archived agents"
          className={cn(
            'w-full flex items-center rounded-lg py-2 text-sm text-muted-foreground transition-colors',
            'hover:bg-gray-100 hover:text-foreground',
            isCollapsed ? 'justify-center px-2' : 'px-2 gap-2',
          )}
        >
          <Archive className="h-4 w-4 flex-shrink-0" />
          {!isCollapsed && <span>Archived</span>}
        </button>
      </SidebarTooltip>
    </div>
  );
}
