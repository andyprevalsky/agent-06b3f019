/**
 * STATE MACHINE: RoseAgentRow (Rose Desktop left bar agent row)
 *
 * Stateless. Only the existing supported status glyphs (UI ledger rows 29/64):
 *   COLLAPSED: CompactRow's gray `Bot` glyph; non-running rows add the
 *              AgentStatusIndicator in the corner (running = bare Bot)
 *   EXPANDED:  AgentStatusIndicator in the leading slot (running = ROSE
 *              dot-matrix, needs input = amber alert, done = muted check,
 *              failed = muted red x) + the title
 * No new colored dots.
 *
 * [REST] --click--------> onClick (select agent)
 * [REST] --right-click--> [MENU OPEN] (RoseAgentRowMenu) --close--> [REST]
 *
 * Selected = darker text + semibold weight. No fills, tiles or rings.
 */

import { Bot } from 'lucide-react';

import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';

import AgentStatusIndicator from '../AgentStatusIndicator';
import { agentDisplayName } from '../agentDisplayName';
import { agentRunStatus } from '../agentRunState';
import type { Agent } from '../../hooks';
import RoseAgentRowMenu, { type RoseAgentMenuActions } from './RoseAgentRowMenu';

interface RoseAgentRowProps {
  agent: Agent;
  isSelected: boolean;
  isExpanded: boolean;
  /** Agents under a project row sit indented while the bar is expanded. */
  indented: boolean;
  hasAttentionRequest: boolean;
  onClick: () => void;
  actions: RoseAgentMenuActions;
  onMenuOpenChange: (open: boolean) => void;
}

export default function RoseAgentRow({
  agent,
  isSelected,
  isExpanded,
  indented,
  hasAttentionRequest,
  onClick,
  actions,
  onMenuOpenChange,
}: RoseAgentRowProps) {
  const runStatus = agentRunStatus(agent, { hasAttentionRequest });
  const name = agentDisplayName(agent);
  const isPinned = agent.pinned_at !== null && agent.pinned_at !== undefined;
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>
        <button
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
            <span data-testid="rose-agent-status" className="inline-grid w-5 flex-none place-items-center">
              <AgentStatusIndicator status={runStatus} seed={agent.agent_id} />
            </span>
          ) : (
            <span className="relative inline-grid flex-none">
              <Bot
                data-sidebar-agent-icon
                className={cn('h-5 w-5', isSelected ? 'text-gray-800' : 'text-gray-500')}
              />
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
  );
}
