/**
 * The code session as an AgentDetail, so the existing transcript and query box
 * read it like any selected agent (CodeAgentContext.tsx):
 *   spinning_up / live / verifying → ACTIVE · completed → COMPLETED
 *   failed → FAILED · paused → PAUSED
 *   model / speed / context_size / tokens / cost ← the session's own records
 *   (codeSessionSettings); unknown stays empty.
 */

import type { AgentDetail } from '@/lib/api/types';
import type { ChipState } from '../../types';
import { eventTimeMs } from '../../hooks/codeAgentContract';
import type { CodeSessionSettings } from '../../hooks/codeSessionSettings';
import type { CodeAgentConversation } from './useCodeAgentConversation';

const STATUS: Record<ChipState, AgentDetail['status']> = {
  spinning_up: 'ACTIVE',
  live: 'ACTIVE',
  verifying: 'ACTIVE',
  completed: 'COMPLETED',
  failed: 'FAILED',
  paused: 'PAUSED',
};

function iso(value: Parameters<typeof eventTimeMs>[0], fallback: string): string {
  const ms = eventTimeMs(value);
  return ms === null ? fallback : new Date(ms).toISOString();
}

/** The code session as an AgentDetail for the transcript and the query box. */
export function codeAgentDetail(
  taskId: string,
  ownerAgentId: string,
  c: CodeAgentConversation,
  settings: CodeSessionSettings,
  firstAt: string,
  messageCount = 0,
): AgentDetail {
  const startedAt = iso(c.meta?.started_at, firstAt);
  const speed = settings.speed;
  return {
    agent_id: taskId,
    goal: c.title,
    title: c.title,
    model: settings.model ?? '',
    source: 'MAC_APP',
    reasoning_effort: 'off',
    progress: 0,
    status: STATUS[c.chipState],
    status_message: c.meta?.failure_message ?? null,
    temporal_workflow_id: null,
    token_count: (settings.tokensIn ?? 0) + (settings.tokensOut ?? 0),
    tokens_in: settings.tokensIn ?? 0,
    tokens_out: settings.tokensOut ?? 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: settings.contextTokens ?? 0,
    message_count: messageCount,
    price_limit_cents: 0,
    tree_cost_cents: settings.costCents ?? 0,
    speed: speed === 'standard' || speed === 'fast' || speed === 'ultrafast' ? speed : undefined,
    created_at: startedAt,
    updated_at: iso(c.meta?.ended_at, startedAt),
    write_lock_enabled: false,
    parent_agent_id: ownerAgentId,
    verifier: null,
    tools: [],
  };
}
