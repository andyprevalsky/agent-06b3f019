/**
 * "Old" agents for the Rose left bar (Andy, 2026-10-26): finished (the bar's
 * Completed/Failed "done" state) and last active more than 4 days ago. Pure:
 * the caller passes one shared `now`, so no row runs its own timer.
 *
 * Never old: running, paused or needs-help agents (incl. an open attention
 * request), pinned agents and the selected agent.
 */
import type { Agent } from '../../hooks';
import { agentRunStatus } from '../agentRunState';

export const OLD_AGENT_AGE_MS = 4 * 24 * 60 * 60 * 1000;

export interface OldAgentContext {
  selectedAgentId: string | null;
  attentionAgentIds: ReadonlySet<string>;
}

export function isOldAgent(agent: Agent, now: number, ctx: OldAgentContext): boolean {
  if (agent.agent_id === ctx.selectedAgentId) return false;
  if (agent.pinned_at !== null && agent.pinned_at !== undefined) return false;
  const status = agentRunStatus(agent, {
    hasAttentionRequest: ctx.attentionAgentIds.has(agent.agent_id),
  });
  if (status.state !== 'done') return false;
  const lastActive = Date.parse(agent.updated_at);
  return Number.isFinite(lastActive) && now - lastActive > OLD_AGENT_AGE_MS;
}

/** Keeps the incoming (display) order within both halves. */
export function splitOldAgents(
  agents: Agent[],
  now: number,
  ctx: OldAgentContext,
): { recent: Agent[]; old: Agent[] } {
  const recent: Agent[] = [];
  const old: Agent[] = [];
  for (const agent of agents) (isOldAgent(agent, now, ctx) ? old : recent).push(agent);
  return { recent, old };
}

export function oldAgentsLabel(count: number, open: boolean): string {
  const noun = count === 1 ? '1 old agent' : `${count} old agents`;
  return open ? `Hide ${noun}` : `View ${noun}`;
}
