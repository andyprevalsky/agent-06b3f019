/**
 * Display-name resolution for agent rows.
 *
 * The backend generates a short `title` from the goal at spawn time, and the
 * user can override it via rename. Until (or unless) that lands, the row falls
 * back to the raw goal — so a title-generation failure is cosmetic, never a
 * blank row.
 */

import type { Agent } from '../hooks';

/** Hard cap on a stored title. Mirrors updateAgentSchema's `max(80)`. */
export const AGENT_TITLE_MAX_CHARS = 80;

/** The label shown for an agent row: its title, else the complete raw goal. */
export function agentDisplayName(agent: Pick<Agent, 'goal' | 'title'>): string {
  const title = agent.title?.trim();
  if (title !== undefined && title !== '') return title;

  // Keep the data intact and let the row's CSS ellipsis respond to the actual
  // sidebar width. A character-count cap leaves avoidable whitespace whenever
  // the user drags the sidebar wider.
  return agent.goal.trim();
}
