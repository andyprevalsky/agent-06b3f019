/**
 * Keep chat LLM contexts scoped to the owning agent.
 *
 * Cross-language twin of agents/helpers/context_scope.py. Shared fixtures live
 * in shared/context-scope/fixtures.json (loaded by back-end chat-compaction and
 * agents context_scope blackboxes). Parent-visible spawn FINISHED / task_complete
 * rows omit subAgentId on purpose so their result bodies survive this filter;
 * explore/browser work-stream rows carry subAgentId and are dropped.
 *
 * for_each child UI rows are producer-marked with ``forEachChild: true`` (see
 * agents/domains/spawn_sub_agents). Historical rows (pre-marker) still use
 * ``<parent>:<idx>`` toolCallIds with nonempty ``subAgentIds``; those stay
 * filtered. A bare provider id like ``toolu:123`` must stay parent-visible.
 */

import type { ChatMessage } from './initialContext';

function isNonEmptySubAgentIds(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Provider-native ids that look like ``base:digits`` but are not for_each children. */
function isProviderNumericToolCallId(toolCallId: string): boolean {
  return /^(toolu|tooluse):\d+$/i.test(toolCallId);
}

/** Historical for_each child UI rows use ``<parent>:<idx>`` (ASCII digit idx). */
function hasHistoricalForEachChildSuffix(toolCallId: string): boolean {
  if (!/:[0-9]+$/.test(toolCallId)) return false;
  return !isProviderNumericToolCallId(toolCallId);
}

export function isInternalSubagentMessage(message: ChatMessage): boolean {
  const metadata = message.metadata ?? {};
  if (metadata.subAgentId) return true;

  if (metadata.forEachAggregate === true) return false;
  if (!isNonEmptySubAgentIds(metadata.subAgentIds)) return false;

  if (metadata.forEachChild === true) return true;

  const toolCallId = String(metadata.toolCallId ?? '');
  return hasHistoricalForEachChildSuffix(toolCallId);
}

export function filterInternalSubagentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !isInternalSubagentMessage(message));
}
