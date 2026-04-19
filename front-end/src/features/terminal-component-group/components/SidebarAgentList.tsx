/**
 * Stateless sidebar agent list.
 * Sorts agents (processing first, then by recency) and renders scrollable list or
 * empty/loading placeholders. All state is owned by the parent (AppSidebar).
 */

import { Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import AgentListItem from './AgentListItem';
import SidebarTooltip from './SidebarTooltip';
import type { Agent } from '../hooks';

interface SidebarAgentListProps {
  agents: Agent[];
  isLoadingAgents: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onResumeAgent: (agentId: string) => Promise<void>;
  resumingAgentId: string | null;
  isCollapsed: boolean;
}

function isProcessing(agent: Agent): boolean {
  return agent.status !== 'COMPLETED' && agent.status !== 'FAILED';
}

function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    const aProc = isProcessing(a);
    const bProc = isProcessing(b);
    if (aProc && !bProc) return -1;
    if (!aProc && bProc) return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function truncateGoal(goal: string): string {
  return goal.length > 50 ? `${goal.slice(0, 50)}...` : goal;
}

export default function SidebarAgentList({
  agents,
  isLoadingAgents,
  selectedAgentId,
  onSelectAgent,
  onResumeAgent,
  resumingAgentId,
  isCollapsed,
}: SidebarAgentListProps) {
  const sorted = sortAgents(agents);
  const isEmpty = sorted.length === 0;
  const showSpinner = isLoadingAgents && agents.length === 0;
  const handleResume = (id: string) => {
    void onResumeAgent(id);
  };

  return (
    <ScrollArea className="flex-1">
      <div className={cn('py-2 space-y-1', isCollapsed ? 'px-1.5' : 'px-3')}>
        {showSpinner ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          !isCollapsed && (
            <div className="text-center py-8 text-muted-foreground text-sm">No agents yet</div>
          )
        ) : (
          sorted.map((agent) => (
            <SidebarTooltip
              key={agent.agent_id}
              label={truncateGoal(agent.goal)}
              isCollapsed={isCollapsed}
            >
              <AgentListItem
                agent={agent}
                isSelected={selectedAgentId === agent.agent_id}
                onClick={() => onSelectAgent(agent.agent_id)}
                onResume={handleResume}
                isResuming={resumingAgentId === agent.agent_id}
                isCompact={isCollapsed}
              />
            </SidebarTooltip>
          ))
        )}
      </div>
    </ScrollArea>
  );
}
