/**
 * STATE MACHINE: RoseAgentRow (Rose Desktop left bar agent row)
 *
 * Stateless. Only the existing supported status glyphs (UI ledger rows 29/64):
 *   COLLAPSED: CompactRow's gray `Bot` glyph; non-running rows add the
 *              AgentStatusIndicator at top right; active count >1 at bottom right
 *   EXPANDED:  AgentStatusIndicator in the leading slot (running = ROSE
 *              dot-matrix, needs input = amber alert, done = muted check,
 *              failed = muted red x) + the title
 * The count inherits the robot color. Expanded rows offer a separate disclosure.
 *
 * [REST] --click--------> onClick (select agent)
 * [REST] --right-click--> [MENU OPEN] (RoseAgentRowMenu) --close--> [REST]
 *
 * Selected = darker text + semibold weight. No fills, tiles or rings.
 */

import { Bot, ChevronDown, ChevronRight } from 'lucide-react';

import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';

import AgentStatusIndicator from '../AgentStatusIndicator';
import { agentDisplayName } from '../agentDisplayName';
import { agentRunStatus } from '../agentRunState';
import type { Agent } from '../../hooks';
import RoseAgentRowMenu, { type RoseAgentMenuActions } from './RoseAgentRowMenu';

interface RoseAgentRowProps {
  agent: Agent;
  activeAgentCount?: number;
  hasChildren?: boolean;
  childrenExpanded?: boolean;
  onToggleChildren?: () => void;
  depth?: number;
  statusOverride?: ReturnType<typeof agentRunStatus>;
  isSelected: boolean;
  isExpanded: boolean;
  /** Agents under a project row sit indented while the bar is expanded. */
  indented: boolean;
  hasAttentionRequest: boolean;
  onClick: () => void;
  actions: RoseAgentMenuActions;
  onMenuOpenChange: (open: boolean) => void;
  /** Visibility ref (the bar reads code agents only for rows on screen). */
  rowRef?: (element: HTMLElement | null) => void;
}

export default function RoseAgentRow({
  agent,
  activeAgentCount = 0,
  hasChildren = false,
  childrenExpanded = false,
  onToggleChildren,
  depth = 0,
  statusOverride,
  isSelected,
  isExpanded,
  indented,
  hasAttentionRequest,
  onClick,
  actions,
  onMenuOpenChange,
  rowRef,
}: RoseAgentRowProps) {
  const runStatus = hasAttentionRequest
    ? agentRunStatus(agent, { hasAttentionRequest })
    : (statusOverride ?? agentRunStatus(agent));
  const name = agentDisplayName(agent);
  const isPinned = agent.pinned_at !== null && agent.pinned_at !== undefined;
  return (
    <div className="relative" data-agent-depth={depth}>
      <ContextMenu onOpenChange={onMenuOpenChange}>
        <ContextMenuTrigger asChild>
          <button
            ref={rowRef}
            style={
              isExpanded
                ? {
                    paddingLeft: 22 + (indented ? 12 : 0) + depth * 16,
                    paddingRight: hasChildren ? 30 : 16,
                  }
                : undefined
            }
            type="button"
            onClick={onClick}
            aria-label={name}
            aria-current={isSelected ? 'true' : undefined}
            data-testid={`rose-agent-row-${agent.agent_id}`}
            data-selected={isSelected}
            title={isExpanded ? agent.goal : name}
            className={cn(
              'flex h-[38px] w-full flex-none items-center gap-3 whitespace-nowrap text-left text-[13px] transition-[padding,color] duration-300',
              isExpanded && indented ? 'pl-[34px] pr-4' : 'px-[22px]',
              isSelected
                ? 'font-semibold text-[hsl(240_15%_15%)] dark:text-[#ecece8]'
                : 'text-[hsl(240_6%_50%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_15%)] dark:hover:text-[#ecece8]',
            )}
          >
            {isExpanded ? (
              <span
                data-testid="rose-agent-status"
                className="inline-grid w-5 flex-none place-items-center"
              >
                <AgentStatusIndicator status={runStatus} seed={agent.agent_id} />
              </span>
            ) : (
              <span
                className={cn(
                  'relative inline-grid flex-none',
                  isSelected
                    ? 'text-gray-800 dark:text-[#ecece8]'
                    : 'text-gray-500 dark:text-[#a3a39d]',
                )}
              >
                <Bot
                  data-sidebar-agent-icon
                  className={cn(
                    'h-5 w-5',
                    isSelected
                      ? 'text-gray-800 dark:text-[#ecece8]'
                      : 'text-gray-500 dark:text-[#a3a39d]',
                  )}
                />
                {activeAgentCount > 1 && (
                  <span
                    data-testid={`rose-agent-count-${agent.agent_id}`}
                    aria-label={`${activeAgentCount} active agents`}
                    className="absolute -bottom-1.5 -right-2 text-[9px] font-semibold leading-none tabular-nums text-current"
                  >
                    {activeAgentCount}
                  </span>
                )}
                {runStatus.state !== 'active' && (
                  <span className="absolute -right-1.5 -top-1">
                    <AgentStatusIndicator status={runStatus} seed={agent.agent_id} />
                  </span>
                )}
              </span>
            )}
            <span
              className={cn(
                'min-w-0 flex-1 truncate transition-opacity duration-200',
                isExpanded ? 'opacity-100' : 'opacity-0',
              )}
            >
              {name}
            </span>
          </button>
        </ContextMenuTrigger>
        <RoseAgentRowMenu isPinned={isPinned} actions={actions} />
      </ContextMenu>
      {isExpanded && hasChildren && (
        <button
          type="button"
          aria-label={`${childrenExpanded ? 'Collapse' : 'Expand'} ${name}`}
          aria-expanded={childrenExpanded}
          onClick={onToggleChildren}
          className="absolute right-2 top-1.5 grid h-7 w-7 place-items-center rounded text-muted-foreground hover:text-foreground"
        >
          {childrenExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      )}
    </div>
  );
}
