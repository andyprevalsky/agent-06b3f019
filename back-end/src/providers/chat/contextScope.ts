/**
 * Keep chat LLM contexts scoped to the owning agent.
 *
 * Cross-language twin of agents/helpers/context_scope.py. Shared fixtures live
 * in shared/context-scope/fixtures.json (loaded by back-end chat-compaction and
 * agents context_scope blackboxes). Parent-visible spawn FINISHED / task_complete
 * rows omit subAgentId on purpose so their result bodies survive this filter;
 * explore/browser work-stream rows carry subAgentId and are dropped.
 */

import type { ChatMessage } from './initialContext';

function isNonEmptySubAgentIds(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** for_each child UI rows use `<base>:<idx>` toolCallIds (idx is digits). */
function hasForEachChildToolCallSuffix(toolCallId: string): boolean {
  return /:[0-9]+$/.test(toolCallId);
}

export function isInternalSubagentMessage(message: ChatMessage): boolean {
  const metadata = message.metadata ?? {};
  if (metadata.subAgentId) return true;

  const toolCallId = String(metadata.toolCallId ?? '');
  return isNonEmptySubAgentIds(metadata.subAgentIds) && hasForEachChildToolCallSuffix(toolCallId);
}

export function filterInternalSubagentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !isInternalSubagentMessage(message));
}
