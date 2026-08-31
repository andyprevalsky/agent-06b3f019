/**
 * Head/tail-protected compaction split.
 *
 * Mirrors agents/helpers/summarize.py:split_head_middle_tail and OpenClaw's
 * keepRecentTokens boundary selection.
 */

import { messageSummaryWeight } from './contextTokens';
import type { ChatMessage } from './initialContext';

export const HEAD_TAIL_PROTECTED_TURNS = 4;
export const KEEP_RECENT_TOKENS = 20_000;
export const MIN_CONTEXT_LEN_FOR_COMPACTION = HEAD_TAIL_PROTECTED_TURNS + 2;

export interface HeadMiddleTailSplit {
  headIndices: number[];
  middleIndices: number[];
  tailIndices: number[];
}

function buildToolPairMaps(messages: ChatMessage[]): {
  assistantById: Map<string, number>;
  toolsById: Map<string, number[]>;
} {
  const assistantById = new Map<string, number>();
  const toolsById = new Map<string, number[]>();

  messages.forEach((message, index) => {
    const meta = message.metadata ?? {};
    if (message.role === 'ASSISTANT') {
      const toolCalls = meta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall?.tool_call_id;
          if (typeof toolCallId === 'string') assistantById.set(toolCallId, index);
        }
      }
    } else if (message.role === 'TOOL') {
      const toolCallId = meta.toolCallId;
      if (typeof toolCallId === 'string') {
        const existing = toolsById.get(toolCallId) ?? [];
        existing.push(index);
        toolsById.set(toolCallId, existing);
      }
    }
  });

  return { assistantById, toolsById };
}

function expandToolPairs(
  messages: ChatMessage[],
  tailIndices: Set<number>,
  headSet: Set<number>
): Set<number> {
  const { assistantById, toolsById } = buildToolPairMaps(messages);
  let changed = true;
  while (changed) {
    changed = false;
    for (const index of [...tailIndices]) {
      const message = messages[index];
      const meta = message.metadata ?? {};
      if (message.role === 'TOOL') {
        const toolCallId = meta.toolCallId;
        if (typeof toolCallId === 'string') {
          const assistantIndex = assistantById.get(toolCallId);
          if (
            assistantIndex !== undefined &&
            !tailIndices.has(assistantIndex) &&
            !headSet.has(assistantIndex)
          ) {
            tailIndices.add(assistantIndex);
            changed = true;
          }
        }
      } else if (message.role === 'ASSISTANT') {
        const toolCalls = meta.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const toolCall of toolCalls) {
            const toolCallId = toolCall?.tool_call_id;
            if (typeof toolCallId !== 'string') continue;
            for (const toolIndex of toolsById.get(toolCallId) ?? []) {
              if (!tailIndices.has(toolIndex) && !headSet.has(toolIndex)) {
                tailIndices.add(toolIndex);
                changed = true;
              }
            }
          }
        }
      }
    }
  }
  return tailIndices;
}

export function splitHeadMiddleTail(
  messages: ChatMessage[],
  nTail = HEAD_TAIL_PROTECTED_TURNS,
  keepRecentTokens = KEEP_RECENT_TOKENS
): HeadMiddleTailSplit | null {
  if (messages.length < MIN_CONTEXT_LEN_FOR_COMPACTION) return null;

  const headIndices: number[] = [];
  let seenFirstUser = false;
  for (let index = 0; index < messages.length; index += 1) {
    const role = messages[index].role;
    if (role === 'SYSTEM' && headIndices.length === 0) {
      headIndices.push(index);
    } else if (role === 'USER' && !seenFirstUser) {
      headIndices.push(index);
      seenFirstUser = true;
      break;
    }
  }

  const headSet = new Set(headIndices);
  const tailIndices = new Set<number>();
  let count = 0;
  let tokenCount = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (headSet.has(index)) break;
    const role = messages[index].role;
    if (role === 'USER' || role === 'ASSISTANT' || role === 'TOOL') {
      tokenCount += messageSummaryWeight(messages[index]);
      tailIndices.add(index);
      count += 1;
      if (count >= nTail && tokenCount >= keepRecentTokens) break;
    }
  }

  for (const targetRole of ['USER', 'ASSISTANT'] as const) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (headSet.has(index)) break;
      if (messages[index].role === targetRole) {
        tailIndices.add(index);
        break;
      }
    }
  }

  expandToolPairs(messages, tailIndices, headSet);

  const middleIndices = messages
    .map((_, index) => index)
    .filter((index) => !headSet.has(index) && !tailIndices.has(index));
  if (middleIndices.length === 0) return null;

  return {
    headIndices,
    middleIndices,
    tailIndices: [...tailIndices].sort((a, b) => a - b),
  };
}
