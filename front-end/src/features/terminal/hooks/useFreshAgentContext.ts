import { useMemo } from 'react';
import type { Agent, AgentDetail } from '../types';

/** Reconcile status by producer freshness before projecting local user intent. */
function fresherSelectedAgent(detail: AgentDetail | null, listed: Agent | undefined) {
  if (!detail || !listed) return detail;
  const listedAt = Date.parse(listed.updated_at);
  const detailAt = Date.parse(detail.updated_at);
  if (!Number.isFinite(listedAt) || !Number.isFinite(detailAt) || listedAt <= detailAt) {
    return detail;
  }
  if (
    detail.user_control_revision !== undefined &&
    (listed.user_control_revision === undefined ||
      listed.user_control_revision < detail.user_control_revision)
  )
    return detail;
  return {
    ...detail,
    status: listed.status,
    status_message: listed.status_message,
    updated_at: listed.updated_at,
    user_control_revision: listed.user_control_revision,
  };
}

/** Cache list identity once per refresh; pause clicks perform one keyed lookup. */
export function useFreshAgentContext<
  T extends { agent: AgentDetail | null; selectedAgentId: string | null },
>(context: T, agents: Agent[]) {
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.agent_id, agent])),
    [agents],
  );
  return {
    ...context,
    agent: fresherSelectedAgent(context.agent, agentsById.get(context.selectedAgentId ?? '')),
  };
}
