/**
 * STATE MACHINE: AgentListItem
 *
 * This component is stateless - receives all state via props.
 * Renders one agent row: pin marker, display name, and hover actions.
 *
 * ROW INTERACTIONS:
 * [REST] --hover--------> [HOVERED]  (pin/archive replace elapsed time)
 * [REST] --right-click--> [MENU OPEN] (Rename | Copy Link | Pin | Archive)
 * [REST] --click--------> onClick (select agent)
 *
 * No pause/resume control lives here: run control belongs to the agent view, and
 * a play button in a navigation list invited mis-clicks while scanning.
 *
 * Props-driven states:
 * - isSelected: boolean (highlight styling; ROW_FILL, readable in light and dark)
 * - isArchived: boolean (menu swaps Archive for Restore, hides Pin)
 * - hasAttentionRequest: boolean (forces the needs-help indicator)
 * - agent.status: drives the leading run indicator (see agentRunState.ts)
 *
 * The leading slot carries a three-state run indicator — working (animated),
 * needs-help (static), done (static). Deliberately NOT rendered here: the
 * progress percentage/wheel and the separate out-of-credits / cost-limit chips.
 * Those competed with the title for the row and said more than a navigation list
 * needs to; out-of-credits and cost-limit now fold into needs-help, and exact
 * progress lives in the agent view. The right-hand slot stays reserved for
 * elapsed time or row actions.
 */

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Archive, ArchiveRestore, Bot, Pin } from 'lucide-react';

import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import AgentRowMenu, { type AgentRowActions } from './AgentRowMenu';
import AgentStatusIndicator from './AgentStatusIndicator';
import { agentDisplayName } from './agentDisplayName';
import { agentRunStatus } from './agentRunState';
import { elapsedSince, formatElapsed } from './formatElapsed';
import type { Agent } from '../hooks';

interface AgentListItemProps extends AgentRowActions {
  agent: Agent;
  isSelected: boolean;
  onClick: () => void;
  isCompact?: boolean;
  isArchived?: boolean;
  hasAttentionRequest?: boolean;
  /** Shared clock from the list; only read by active rows. */
  now?: number;
}

/** A row action (pin, archive, restore). Visibility is owned by RowTrailing. */
function RowActionButton({
  icon,
  label,
  tooltip,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tooltip: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={label}
          className="flex-shrink-0 rounded p-0.5 hover:bg-gray-200 dark:hover:bg-white/10"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

const ACTION_ICON = 'h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground';

/**
 * Hover/selected fill. Light mode keeps the navi grey; dark mode (html.dark,
 * Rose Desktop) uses the theme's `accent` hover token, because the fixed
 * #e5e5e5 grey under the dark theme's near-white text was unreadable.
 */
const ROW_FILL = {
  selected: 'bg-navi-white-dark dark:bg-accent',
  hover: 'hover:bg-navi-white-dark dark:hover:bg-accent',
} as const;

/**
 * The row's trailing slot: run duration at rest, row actions on hover.
 *
 * Both occupy the SAME trailing slot — the duration sits in normal flow and
 * the actions are layered over it. At rest the slot is only as wide as what is
 * visible (pin and/or elapsed time), so invisible controls never steal title
 * width. On hover the actions anchor to the row's right edge and cover only the
 * text underneath them.
 *
 * Visibility is opacity-based, never `hidden`: display:none would drop the
 * buttons out of the tab order entirely. `group-focus-within` reveals them for
 * keyboard users, who get no hover event.
 *
 * `tabular-nums` stops the duration jittering as digits change width.
 */
function RowTrailing({
  elapsed,
  isPinned,
  children,
}: {
  elapsed: string | null;
  isPinned: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="relative flex h-4 min-w-0 flex-shrink-0 items-center justify-end">
      <span className="flex items-center gap-1 whitespace-nowrap transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0">
        {/* Pinned is a persistent user-set state, so it must survive the actions
            being hidden — otherwise a pinned row is indistinguishable at rest
            except by its sort position. */}
        {isPinned && (
          <Pin
            className="h-3 w-3 flex-shrink-0 fill-current text-gray-500 dark:text-muted-foreground"
            aria-hidden="true"
          />
        )}
        {elapsed !== null && (
          <span
            className="whitespace-nowrap text-[11px] leading-none tabular-nums text-gray-400"
            title={`Running for ${elapsed}`}
          >
            {elapsed}
          </span>
        )}
      </span>
      <span className="absolute inset-y-0 right-0 z-10 flex items-center gap-0.5 rounded bg-navi-white-dark dark:bg-accent opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
        {children}
      </span>
    </span>
  );
}

/**
 * Collapsed-rail row: too narrow for a label, so show an agent glyph with the
 * run indicator tucked at the corner — the rail is where a user is most likely
 * to miss an agent that has gone quiet waiting on them.
 */
const CompactRow = forwardRef<
  HTMLDivElement,
  {
    runStatus: ReturnType<typeof agentRunStatus>;
    seed: string;
    isSelected: boolean;
    onClick: () => void;
  } & ComponentPropsWithoutRef<'div'>
>(function CompactRow({ runStatus, seed, isSelected, onClick, ...triggerProps }, ref) {
  return (
    <div
      ref={ref}
      onClick={onClick}
      {...triggerProps}
      className={cn(
        'relative flex w-full cursor-pointer items-center justify-center rounded-lg p-2 transition-colors',
        isSelected ? ROW_FILL.selected : ROW_FILL.hover,
      )}
    >
      {/* A shared agent glyph, not the title's initial: a column of unrelated
          letters read as noise, and the run indicator in the corner already
          carries the per-row state. */}
      <Bot
        data-sidebar-agent-icon
        className={cn(
          'h-5 w-5',
          isSelected ? 'text-gray-800 dark:text-foreground' : 'text-gray-500',
        )}
      />
      {runStatus.state !== 'active' && (
        <span className="absolute -top-0.5 right-0.5">
          <AgentStatusIndicator status={runStatus} seed={seed} />
        </span>
      )}
    </div>
  );
});

/**
 * Full-width row: run indicator, title, then one trailing elapsed/actions slot.
 *
 * Layout order matters. The duration and actions occupy the same fixed-width
 * slot, so hover never displaces the title or shifts a control under the pointer.
 */
const ExpandedRow = forwardRef<
  HTMLDivElement,
  {
    agent: Agent;
    displayName: string;
    runStatus: ReturnType<typeof agentRunStatus>;
    isPinned: boolean;
    isSelected: boolean;
    isArchived: boolean;
    now: number;
    onClick: () => void;
    onArchiveClick: (e: React.MouseEvent) => void;
    onPinClick: (e: React.MouseEvent) => void;
  } & ComponentPropsWithoutRef<'div'>
>(function ExpandedRow(
  {
    agent,
    displayName,
    runStatus,
    isPinned,
    isSelected,
    isArchived,
    now,
    onClick,
    onArchiveClick,
    onPinClick,
    ...triggerProps
  },
  ref,
) {
  return (
    <div
      ref={ref}
      onClick={onClick}
      {...triggerProps}
      className={cn(
        'group/row w-full cursor-pointer rounded-md px-2 py-1 text-left transition-colors',
        // No chrome at rest: a list of filled cards fights the content. Colour
        // appears on hover, and selection keeps a persistent fill so the current
        // agent is still identifiable once the pointer moves away.
        isSelected ? ROW_FILL.selected : ROW_FILL.hover,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AgentStatusIndicator status={runStatus} seed={agent.agent_id} />
        <h3 className="ml-0.5 min-w-0 flex-1 truncate text-sm font-medium" title={agent.goal}>
          {displayName}
        </h3>
        <RowTrailing
          isPinned={isPinned}
          elapsed={
            runStatus.state === 'active' ? formatElapsed(elapsedSince(agent.created_at, now)) : null
          }
        >
          {!isArchived && (
            <RowActionButton
              label={isPinned ? `Unpin ${displayName}` : `Pin ${displayName}`}
              tooltip={isPinned ? 'Unpin Agent' : 'Pin Agent'}
              onClick={onPinClick}
              icon={<Pin className={cn(ACTION_ICON, isPinned && 'fill-current text-gray-600')} />}
            />
          )}
          <RowActionButton
            label={`${isArchived ? 'Restore' : 'Archive'} ${displayName}`}
            tooltip={isArchived ? 'Restore Agent' : 'Archive Agent'}
            onClick={onArchiveClick}
            icon={
              isArchived ? (
                <ArchiveRestore className={ACTION_ICON} />
              ) : (
                <Archive className={ACTION_ICON} />
              )
            }
          />
        </RowTrailing>
      </div>
    </div>
  );
});

export default function AgentListItem({
  agent,
  isSelected,
  onClick,
  isCompact = false,
  isArchived = false,
  hasAttentionRequest = false,
  now = 0,
  onRename,
  onCopyLink,
  onTogglePin,
  onArchive,
  onRestore,
}: AgentListItemProps) {
  const stop = (handler: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    handler();
  };

  const isPinned = agent.pinned_at !== null && agent.pinned_at !== undefined;
  const displayName = agentDisplayName(agent);
  const runStatus = agentRunStatus(agent, { hasAttentionRequest, isArchived });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {isCompact ? (
          <CompactRow
            runStatus={runStatus}
            seed={agent.agent_id}
            isSelected={isSelected}
            onClick={onClick}
          />
        ) : (
          <ExpandedRow
            agent={agent}
            displayName={displayName}
            runStatus={runStatus}
            isPinned={isPinned}
            isSelected={isSelected}
            isArchived={isArchived}
            now={now}
            onClick={onClick}
            onArchiveClick={stop(isArchived ? () => onRestore?.() : onArchive)}
            onPinClick={stop(onTogglePin)}
          />
        )}
      </ContextMenuTrigger>
      <AgentRowMenu
        isPinned={isPinned}
        isArchived={isArchived}
        onRename={onRename}
        onCopyLink={onCopyLink}
        onTogglePin={onTogglePin}
        onArchive={onArchive}
        onRestore={onRestore}
      />
    </ContextMenu>
  );
}
