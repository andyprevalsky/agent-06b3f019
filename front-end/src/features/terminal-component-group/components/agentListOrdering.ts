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
 * Ordering weight per run state: what is blocked on YOU outranks what is running
 * on its own, which outranks what is already over. A needs-help row that sorted
 * below thirty active runs is a row you never see.
 */
const RUN_STATE_RANK: Record<AgentRunState, number> = {
  'needs-help': 0,
  active: 1,
  done: 2,
};

/**
 * Pinned first, then by run state (needs-help, active, done), then newest.
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
    RUN_STATE_RANK[
      agentRunStatus(a, { hasAttentionRequest: attentionAgentIds.has(a.agent_id), isArchived })
        .state
    ];

  return [...agents].sort((a, b) => {
    if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
    const byState = rank(a) - rank(b);
    if (byState !== 0) return byState;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
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
