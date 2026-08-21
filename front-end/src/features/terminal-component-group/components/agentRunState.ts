/**
 * Derives the sidebar's three-state run indicator from an agent's status plus
 * whether it has an unanswered attention request.
 *
 * The sidebar deliberately collapses seven backend statuses into three families,
 * because the question a user asks when scanning the list is only ever "is this
 * moving, is it stuck on me, or is it over?":
 *
 *   ACTIVE     STARTING_UP, ACTIVE          animated  — it is moving on its own
 *   NEEDS_HELP unanswered attention request static    — blocked until you act
 *              OUT_OF_CREDITS
 *              COST_LIMIT_REACHED
 *              PAUSED
 *   DONE       COMPLETED, FAILED            static    — terminal, nothing to do
 *
 * Motion is the signal that separates the families: only ACTIVE animates, so a
 * still row always means "no progress is happening". That inverts the usual
 * spinner-everywhere pattern on purpose — an animation that never stops stops
 * meaning anything.
 *
 * NEEDS_HELP outranks the raw status: an agent can hold an unanswered question
 * while its row still reads ACTIVE (the workflow is parked on the request, not
 * finished), and the blocked-on-you reading is the one that matters.
 *
 * FAILED sits in DONE rather than NEEDS_HELP: it is terminal, and nothing the
 * user does in the sidebar unblocks it. It keeps a distinct glyph/tone inside
 * that family so it does not read as a clean success.
 */

import type { Agent } from '../hooks';

export type AgentRunState = 'active' | 'needs-help' | 'done';

/** Why a row is in the needs-help family — drives the tooltip copy. */
export type NeedsHelpReason = 'attention' | 'out-of-credits' | 'cost-limit' | 'paused';

export interface AgentRunStatus {
  state: AgentRunState;
  /** Only set when state === 'needs-help'. */
  reason?: NeedsHelpReason;
  /** Only set when state === 'done'. Distinguishes success from failure. */
  failed?: boolean;
  /** Human-readable label, used for both the tooltip and the a11y name. */
  label: string;
}

const NEEDS_HELP_LABEL: Record<NeedsHelpReason, string> = {
  attention: 'Needs your input',
  'out-of-credits': 'Out of credits',
  'cost-limit': 'Cost limit reached',
  paused: 'Paused',
};

export interface AgentRunStatusOptions {
  /** From the single app-wide attention subscription — the row never fetches. */
  hasAttentionRequest?: boolean;
  /** Row is in the archived list. */
  isArchived?: boolean;
}

/**
 * Map an agent to its sidebar run state.
 *
 * Archived rows are forced terminal. Archiving terminates the Temporal workflow
 * but deliberately leaves `status` untouched as a record of how the run ended,
 * so an archived agent can still read ACTIVE. Animating that row would promise
 * progress that cannot happen.
 */
export function agentRunStatus(
  agent: Agent,
  { hasAttentionRequest = false, isArchived = false }: AgentRunStatusOptions = {},
): AgentRunStatus {
  if (isArchived) {
    return { state: 'done', failed: agent.status === 'FAILED', label: 'Archived' };
  }

  // Checked before status so a parked-but-still-ACTIVE agent reads as blocked.
  if (hasAttentionRequest) {
    return { state: 'needs-help', reason: 'attention', label: NEEDS_HELP_LABEL.attention };
  }

  switch (agent.status) {
    case 'OUT_OF_CREDITS':
      return {
        state: 'needs-help',
        reason: 'out-of-credits',
        label: NEEDS_HELP_LABEL['out-of-credits'],
      };
    case 'COST_LIMIT_REACHED':
      return {
        state: 'needs-help',
        reason: 'cost-limit',
        label: NEEDS_HELP_LABEL['cost-limit'],
      };
    case 'PAUSED':
      return { state: 'needs-help', reason: 'paused', label: NEEDS_HELP_LABEL.paused };
    case 'COMPLETED':
      return { state: 'done', failed: false, label: 'Completed' };
    case 'FAILED':
      return { state: 'done', failed: true, label: 'Failed' };
    case 'STARTING_UP':
    case 'ACTIVE':
      return { state: 'active', label: 'Working' };
  }
}

/** True when the agent is doing work under its own power. */
export function isAgentActive(agent: Agent, options: AgentRunStatusOptions = {}): boolean {
  return agentRunStatus(agent, options).state === 'active';
}
