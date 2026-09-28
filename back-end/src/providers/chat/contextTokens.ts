/**
 * Canonical context-size estimator for chat compaction.
 *
 * Mirrors agents/helpers/summarize.py:estimate_context_tokens so the trigger,
 * tail budget, and post-compaction savings guard never disagree.
 */

import type { ChatMessage } from './initialContext';

export const ESTIMATE_SAFETY_MULTIPLIER = 1.4;

const SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*([^\s,;]+)/gi,
  /(bearer\s+)[a-z0-9._~+/=-]{12,}/gi,
];

function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, ...groups) => {
      if (groups.length >= 2 && typeof groups[0] === 'string') {
        return `${groups[0]}=[REDACTED]`;
      }
      if (typeof groups[0] === 'string') {
        return `${groups[0]}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return redacted;
}

function truncateMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.max(1, Math.floor(limit * 0.7));
  const tail = Math.max(1, limit - head);
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}\n...[truncated ${omitted} chars]...\n${value.slice(-tail)}`;
}

function jsonDumpsSafe(value: unknown, limit = 5_000): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, null, 2);
  } catch {
    rendered = String(value);
  }
  return truncateMiddle(redactSensitiveText(rendered), limit);
}

function messageText(message: ChatMessage): string {
  if (typeof message.text === 'string') return message.text;
  return jsonDumpsSafe(message.text);
}

export function estimateTokensForCompaction(value: string): number {
  return Math.max(1, Math.floor((value.length / 4) * ESTIMATE_SAFETY_MULTIPLIER));
}

export function messageSummaryWeight(message: ChatMessage): number {
  const meta = message.metadata ?? {};
  const renderedParts = [messageText(message)];
  if (meta.structured_response !== undefined) {
    renderedParts.push(jsonDumpsSafe(meta.structured_response));
  }
  if (meta.tool_calls !== undefined) {
    renderedParts.push(jsonDumpsSafe(meta.tool_calls));
  }
  if (meta.attachments !== undefined) {
    renderedParts.push(jsonDumpsSafe(meta.attachments));
  }
  if (meta.file_pointer !== undefined || message.filePointer !== undefined) {
    renderedParts.push(jsonDumpsSafe(meta.file_pointer ?? message.filePointer));
  }
  return estimateTokensForCompaction(renderedParts.join('\n'));
}

export function estimateContextTokens(messages: ChatMessage[]): number {
  // Sub-agent internal rows are excluded because callers must already strip
  // them (agent: filter_internal_subagent_messages; chat: contextScope.ts).
  // Counting them here while a caller still sends them to the model is how
  // post-completion chat on agent 3b5c2813 blew past Cerebras/OpenRouter
  // 131k with estimateContextTokens still under the 167k compact trigger.
  return messages.reduce((total, message) => {
    if (message.metadata?.subAgentId) return total;
    return total + messageSummaryWeight(message);
  }, 0);
}

export function compactionSavedRatio(originalTokens: number, compressedTokens: number): number {
  if (originalTokens <= 0) return 0;
  return (originalTokens - compressedTokens) / originalTokens;
}
