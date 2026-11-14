/**
 * STATE MACHINE: TaskCompletedBar (attached to the top of the query box)
 *
 * [HIDDEN]  no viewed agent, a detail that belongs to another agent (switching),
 *           a sub-agent (parent_agent_id set: the archived list and its
 *           Restore cover top-level agents only), or status !== COMPLETED
 *     | the viewed top-level agent's status becomes COMPLETED
 *     v
 * [SHOWN]   "Task Completed" (left) · "Archive Agent" button (right)
 *     | status leaves COMPLETED (a follow-up message resumes it) -> [HIDDEN]
 *     | click Archive Agent -> the sidebar's own archive action
 *     |   (useAgentRowActions.onArchiveAgent): DELETE soft delete, selection
 *     |   clears, "Archived …" toast, agent list + attention requests refetch;
 *     |   failure -> "Failed to archive agent" toast, stays [SHOWN]
 *     v
 * [HIDDEN]  selection cleared -> the composer is back on a new agent
 *
 * PLACEMENT: AgentChatArea renders it in QueryInput's topAttachment after the
 *   BackgroundAgentsBanner, so it sits directly above the query box in the
 *   box's own column and edges. data-query-input-attachment squares the box's
 *   top corners; the bar squares its own when the banner sits above it.
 */
import { useContext } from 'react';

import { Button } from '@/components/ui/button';

import type { AgentDetail } from '../hooks';
import { AttentionRequestsContext } from './attention-inbox/attentionRequestsContext';
import { useAgentRowActions } from './useAgentRowActions';

interface TaskCompletedBarProps {
  /** The viewed agent's detail; null until it loads. */
  agent: AgentDetail | null;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onRefreshAgents: () => void | Promise<void>;
}

/** The viewed top-level agent finished its task. */
function showsTaskCompletedBar(
  agent: AgentDetail | null,
  selectedAgentId: string | null,
): agent is AgentDetail {
  return (
    agent !== null &&
    agent.agent_id === selectedAgentId &&
    !agent.parent_agent_id &&
    agent.status === 'COMPLETED'
  );
}

export function TaskCompletedBar({
  agent,
  selectedAgentId,
  onSelectAgent,
  onRefreshAgents,
}: TaskCompletedBarProps) {
  // Nullable read, like PinnedQuestionMount: the app-wide provider wraps the
  // chat column, and an archived agent's requests must leave the inbox at once.
  const attention = useContext(AttentionRequestsContext);
  const { handlers } = useAgentRowActions({
    onRefresh: onRefreshAgents,
    onRefreshAttention: attention?.refetch,
    selectedAgentId,
    onSelectAgent,
  });
  if (!showsTaskCompletedBar(agent, selectedAgentId)) return null;
  return (
    <div
      className="relative z-10 flex items-center gap-2 rounded-t-xl border border-b-0 border-border bg-card px-3 py-1 text-sm text-foreground [[data-query-input-attachment]+&]:rounded-t-none"
      data-testid="task-completed-bar"
      data-query-input-attachment=""
    >
      <span className="min-w-0 flex-1 truncate font-medium">Task Completed</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 shrink-0 px-2"
        onClick={() => handlers.onArchiveAgent(agent)}
      >
        Archive Agent
      </Button>
    </div>
  );
}
