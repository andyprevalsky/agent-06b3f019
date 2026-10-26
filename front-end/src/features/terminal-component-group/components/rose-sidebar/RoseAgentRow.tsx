import { formatProgressEta, validProgressEstimate } from '@/lib/progressEstimate';
import AgentProgressRing from './AgentProgressRing';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
/**
 * STATE MACHINE: RoseAgentRow (Rose Desktop left bar agent row)
 *
 * Stateless. Active rows show a full-size bot with a fixed top-right progress badge:
 *   COLLAPSED: Full-size bot with progress badge; non-running gray Bot rows add the
 *              AgentStatusIndicator at top right; active count >1 at bottom right
 *   EXPANDED:  full-size bot in every state + top-right badge; needs input = amber alert, done = muted check,
 *              failed = muted red x) + the title
 * The count inherits the robot color. Expanded rows offer a separate disclosure. ETA appears only on hover, in a tooltip above the row.
 *
 * [REST] --click--------> onClick (select agent)
 * [REST] --right-click--> [MENU OPEN] (RoseAgentRowMenu) --close--> [REST]
 *
 * Selected = darker text + semibold weight. Active rows show the model prediction ring.
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
  /** Mobile active agents use a static robot instead of the desktop letter animation. */
  mobile?: boolean;
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
  const estimate = validProgressEstimate(agent.progress_estimate, agent.agent_id, agent.task_id);
  const agentIcon = (
    <span
      data-testid="agent-working-icon"
      className="relative inline-grid h-5 w-5 flex-none place-items-center"
    >
      <Bot data-sidebar-agent-icon className="h-5 w-5" aria-hidden="true" />
      <span
        data-testid={runStatus.state === 'active' ? 'agent-progress-badge' : 'agent-status-badge'}
        className="absolute -right-1.5 -top-1"
      >
        {runStatus.state === 'active' ? (
          <AgentProgressRing estimate={estimate} />
        ) : (
          <AgentStatusIndicator status={runStatus} seed={agent.agent_id} />
        )}
      </span>
    </span>
  );
  const name = agentDisplayName(agent);
  const isPinned = agent.pinned_at !== null && agent.pinned_at !== undefined;
  return (
    <div className="relative" data-agent-depth={depth}>
      <Tooltip>
        <ContextMenu onOpenChange={onMenuOpenChange}>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
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
                title={
                  runStatus.state === 'active' && estimate
                    ? undefined
                    : isExpanded
                      ? agent.goal
                      : name
                }
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
                    {agentIcon}
                  </span>
                ) : (
                  <span
                    className={cn(
                      'relative inline-grid flex-none',
                      runStatus.state === 'active' && '-ml-1',
                      isSelected
                        ? 'text-gray-800 dark:text-[#ecece8]'
                        : 'text-gray-500 dark:text-[#a3a39d]',
                    )}
                  >
                    {agentIcon}
                    {activeAgentCount > 1 && (
                      <span
                        data-testid={`rose-agent-count-${agent.agent_id}`}
                        aria-label={`${activeAgentCount} active agents`}
                        className="absolute -bottom-1.5 -right-2 text-[9px] font-semibold leading-none tabular-nums text-current"
                      >
                        {activeAgentCount}
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
            </TooltipTrigger>
          </ContextMenuTrigger>
          <RoseAgentRowMenu isPinned={isPinned} actions={actions} />
        </ContextMenu>
        {runStatus.state === 'active' && estimate && (
          <TooltipContent side="top" align="start" sideOffset={8} avoidCollisions={false}>
            Estimated time remaining: ~{formatProgressEta(estimate.etaSeconds)}
          </TooltipContent>
        )}
      </Tooltip>
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
