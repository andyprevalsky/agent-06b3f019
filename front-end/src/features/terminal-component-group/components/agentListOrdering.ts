/**
 * Pure ordering + filtering for sidebar agent lists, shared by the stock
 * SidebarAgentList and the Rose Desktop left bar (kept out of the component
 * module so React fast refresh sees component-only exports there).
 */

import { agentDisplayName } from './agentDisplayName';
import { agentRunStatus, type AgentRunState } from './agentRunState';
import type { Agent } from '../hooks';

export function isPinned(agent: Agent): boolean {
  return agent.pinned_at !== null && agent.pinned_at !== undefined;
}

/**
 * Ordering weight per run state: what is running comes first, then what is
 * blocked on you, then what is already over (Andy, 2026-11-06).
 */
const RUN_STATE_RANK: Record<AgentRunState, number> = {
  active: 0,
  'needs-help': 1,
  done: 2,
};

/** Rank of a run state in every sidebar list (roots, folders, sub-agents). */
export function runStateRank(state: AgentRunState): number {
  return RUN_STATE_RANK[state];
}

/**
 * Recency key inside a run-state tier: the newest message a person sent the
 * agent, or its creation (the goal is the first user message) when none since.
 */
export function lastUserMessageTime(
  lastUserMessageAt: string | null | undefined,
  createdAt: string | undefined,
): number {
  const at = Date.parse(lastUserMessageAt ?? createdAt ?? '');
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Pinned first, then by run state (active, needs-help, done), then the most
 * recent user message.
 *
 * The backend orders pinned-then-recent; re-sorting here adds the run-state tier
 * (which depends on client-only attention data) and keeps the list correct
 * between an optimistic pin toggle and the next refetch.
 */
export function sortAgents(
  agents: Agent[],
  attentionAgentIds: ReadonlySet<string>,
  isArchived: boolean,
): Agent[] {
  const rank = (a: Agent) =>
    runStateRank(
      agentRunStatus(a, { hasAttentionRequest: attentionAgentIds.has(a.agent_id), isArchived })
        .state,
    );
  const recency = (a: Agent) => lastUserMessageTime(a.last_user_message_at, a.created_at);

  return [...agents].sort((a, b) => {
    if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
    const byState = rank(a) - rank(b);
    if (byState !== 0) return byState;
    return recency(b) - recency(a);
  });
}

/**
 * Match against BOTH the display name and the raw goal: a generated title is a
 * lossy summary, so searching for a word the user actually typed in their goal
 * must still find the run even when the title dropped that word.
 */
export function matchesQuery(
  agent: Agent,
  needle: string,
  contentMatchAgentIds: ReadonlySet<string>,
): boolean {
  if (needle === '') return true;
  if (contentMatchAgentIds.has(agent.agent_id)) return true;
  const haystack = `${agentDisplayName(agent)} ${agent.goal}`.toLowerCase();
  return haystack.includes(needle);
}
