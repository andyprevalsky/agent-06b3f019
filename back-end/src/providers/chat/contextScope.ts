/**
 * Keep chat LLM contexts scoped to the owning agent.
 *
 * Mirrors agents/helpers/context_scope.py. The agent loop strips
 * ``metadata.subAgentId`` rows before the model sees them; chat mode must do
 * the same. The compaction estimator also skips those rows, so sending them
 * to Router/Generator while estimating without them leaves post-completion
 * chat over the provider window with no auto-compact trigger
 * (prod agent 3b5c2813-c8bd-4ddb-a8bf-f7561c1f7125).
 */

import type { ChatMessage } from './initialContext';

export function isInternalSubagentMessage(message: ChatMessage): boolean {
  const metadata = message.metadata ?? {};
  if (metadata.subAgentId) return true;

  const toolCallId = String(metadata.toolCallId ?? '');
  return Boolean(metadata.subAgentIds && toolCallId.includes(':'));
}

export function filterInternalSubagentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !isInternalSubagentMessage(message));
}
