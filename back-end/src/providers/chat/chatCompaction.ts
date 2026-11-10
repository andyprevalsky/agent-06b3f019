/**
 * Chat-mode auto-compaction.
 *
 * System context:
 *
 *   load raw DB messages
 *     -> project existing context_reset checkpoints
 *     -> if over auto-compact threshold:
 *          head/tail split + Rose summary
 *          -> persist context_reset row (durable checkpoint)
 *          -> re-project
 *     -> Router / Generator
 *
 * Trigger math mirrors Claude Code autoCompact.ts and agents/loop/run_agent.py.
 */

import { v4 as uuidv4 } from 'uuid';
import { createMessage } from '../messages';
import { createStreamingCompletion } from '../rose';
import { createLogger } from '../logger';
import {
  buildContextCompactionMetadata,
  projectModelContextAfterCompaction,
} from './contextCompaction';
import {
  compactionSavedRatio,
  estimateContextTokens,
  estimateTokensForCompaction,
  messageSummaryWeight,
} from './contextTokens';
import {
  COMPACTION_SUMMARY_PREFIX,
  NO_TOOLS_PREAMBLE,
  NO_TOOLS_TRAILER,
  PARTIAL_COMPACT_PROMPT,
  stripCompactAnalysis,
} from './chatCompactionPrompts';
import type { ChatMessage } from './initialContext';
import { KEEP_RECENT_TOKENS, splitHeadMiddleTail } from './splitHeadMiddleTail';
import { selectChatPhaseModels } from './phaseModels';

const log = createLogger('ChatCompaction');

export const CHAT_MAX_CONTEXT_TOKENS = 200_000;
export const EFFECTIVE_OUTPUT_RESERVATION = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const MIN_AUTOCOMPACT_SAVINGS_RATIO = 0.1;

const SUMMARY_MESSAGE_CHAR_BUDGET = 7_500;
const SUMMARY_FIELD_CHAR_BUDGET = 5_000;
const SUMMARY_TOOL_ARGS_CHAR_BUDGET = 2_000;

function truncateMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.max(1, Math.floor(limit * 0.7));
  const tail = Math.max(1, limit - head);
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}\n...[truncated ${omitted} chars]...\n${value.slice(-tail)}`;
}

function jsonDumpsSafe(value: unknown, limit = SUMMARY_FIELD_CHAR_BUDGET): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, null, 2);
  } catch {
    rendered = String(value);
  }
  return truncateMiddle(rendered, limit);
}

function formatToolCallForPrompt(toolCall: Record<string, unknown>): string {
  const args =
    toolCall.arguments ??
    Object.fromEntries(
      Object.entries(toolCall).filter(
        ([key]) => !['tool', 'tool_call_id', 'id', 'name'].includes(key)
      )
    );
  return jsonDumpsSafe(
    {
      tool: toolCall.tool ?? toolCall.name,
      tool_call_id: toolCall.tool_call_id ?? toolCall.id,
      arguments: args,
    },
    SUMMARY_TOOL_ARGS_CHAR_BUDGET
  );
}

function formatMiddleForPrompt(messages: ChatMessage[], middleIndices: number[]): string {
  const parts: string[] = [];
  for (const index of middleIndices) {
    const message = messages[index];
    const meta = message.metadata ?? {};
    let prefix = `message_index=${index} role=${message.role}`;
    if (typeof meta.toolName === 'string') prefix += ` tool=${meta.toolName}`;
    if (typeof meta.toolStatus === 'string') prefix += ` status=${meta.toolStatus}`;
    if (typeof meta.toolCallId === 'string') prefix += ` tool_call_id=${meta.toolCallId}`;
    if (typeof meta.title === 'string') prefix += ` title=${meta.title}`;

    const lines = [`--- ${prefix} ---`];
    const text = truncateMiddle(message.text ?? '', SUMMARY_FIELD_CHAR_BUDGET);
    if (text) lines.push(`text:\n${text}`);

    if (message.role === 'ASSISTANT' && Array.isArray(meta.tool_calls)) {
      lines.push('assistant_tool_calls:');
      for (const toolCall of meta.tool_calls) {
        if (toolCall && typeof toolCall === 'object') {
          lines.push(formatToolCallForPrompt(toolCall as Record<string, unknown>));
        }
      }
    }

    if (meta.structured_response !== undefined) {
      lines.push('structured_response:');
      lines.push(jsonDumpsSafe(meta.structured_response));
    }

    parts.push(truncateMiddle(lines.join('\n'), SUMMARY_MESSAGE_CHAR_BUDGET));
  }
  return parts.join('\n\n');
}

export function getAutoCompactThreshold(maxContextTokens = CHAT_MAX_CONTEXT_TOKENS): number {
  const effectiveWindow = maxContextTokens - EFFECTIVE_OUTPUT_RESERVATION;
  return effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
}

export function shouldAutoCompactChat(
  messages: ChatMessage[],
  maxContextTokens = CHAT_MAX_CONTEXT_TOKENS
): boolean {
  const trigger = getAutoCompactThreshold(maxContextTokens);
  return estimateContextTokens(messages) >= trigger;
}

async function summarizeMiddle(
  messages: ChatMessage[],
  middleIndices: number[],
  model: string,
  agentId: string
): Promise<string> {
  const middleText = formatMiddleForPrompt(messages, middleIndices);
  const prompt = `${NO_TOOLS_PREAMBLE}${PARTIAL_COMPACT_PROMPT}

TURNS TO SUMMARIZE:
${middleText}

Write only the summary, starting with "${COMPACTION_SUMMARY_PREFIX}" prefix.
${NO_TOOLS_TRAILER}`;

  let accumulated = '';
  const stream = await createStreamingCompletion({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 8_000,
    // rose-fast pool path (same as chat router/generator) — no provider_route override
    dump_context: {
      call_site: 'chat_compaction',
      agent_id: agentId,
    },
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? '';
    if (delta) accumulated += delta;
  }

  let summary = stripCompactAnalysis(accumulated.trim());
  if (!summary) {
    throw new Error('Chat compaction summarizer returned empty text');
  }
  if (!summary.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    summary = `${COMPACTION_SUMMARY_PREFIX} ${summary}`;
  }
  return summary;
}

export async function compressChatContext(params: {
  messages: ChatMessage[];
  model: string;
  agentId: string;
}): Promise<ChatMessage[]> {
  const originalTokens = estimateContextTokens(params.messages);
  // A recent result can outweigh the entire model window. Compact its body
  // before protecting the tail; the raw DB row remains available as evidence.
  // Preserve message order, user instructions, tool-call identity and status.
  let compressed = params.messages;
  if (shouldAutoCompactChat(compressed)) {
    const oversizedTools = compressed
      .map((message, index) => ({ index, weight: messageSummaryWeight(message) }))
      .filter(
        ({ index, weight }) => compressed[index].role === 'TOOL' && weight > KEEP_RECENT_TOKENS
      )
      .sort((a, b) => b.weight - a.weight);
    for (const { index, weight } of oversizedTools) {
      if (!shouldAutoCompactChat(compressed)) break;
      const summary = await summarizeMiddle(compressed, [index], params.model, params.agentId);
      const summarized: ChatMessage = {
        ...structuredClone(compressed[index]),
        text: summary,
        metadata: { ...structuredClone(compressed[index].metadata), compactionSummary: true },
      };
      if (messageSummaryWeight(summarized) >= weight) {
        throw new Error('Tool-result compaction did not reduce context');
      }
      compressed = compressed.map((message, position) =>
        position === index ? summarized : message
      );
    }
  }

  // Skip the ordinary pass only if pressure relief satisfies both budget and
  // savings contracts; otherwise the final guard would discard that relief.
  if (
    compressed === params.messages ||
    shouldAutoCompactChat(compressed) ||
    compactionSavedRatio(originalTokens, estimateContextTokens(compressed)) <
      MIN_AUTOCOMPACT_SAVINGS_RATIO
  ) {
    const split = splitHeadMiddleTail(compressed);
    if (split) {
      const summary = await summarizeMiddle(
        compressed,
        split.middleIndices,
        params.model,
        params.agentId
      );
      compressed = [
        ...split.headIndices.map((index) => structuredClone(compressed[index])),
        { role: 'USER', text: summary, metadata: { compactionSummary: true } },
        ...split.tailIndices.map((index) => structuredClone(compressed[index])),
      ];
    } else if (compressed === params.messages) {
      return params.messages;
    }
  }

  const compressedTokens = estimateContextTokens(compressed);
  if (compressedTokens >= originalTokens) {
    throw new Error(
      `Compaction did not reduce context (${originalTokens} -> ${compressedTokens} estimated tokens)`
    );
  }

  const savedRatio = compactionSavedRatio(originalTokens, compressedTokens);
  if (savedRatio < MIN_AUTOCOMPACT_SAVINGS_RATIO) {
    throw new Error(
      `Compaction savings below minimum (${savedRatio.toFixed(3)} < ${MIN_AUTOCOMPACT_SAVINGS_RATIO})`
    );
  }

  log.info('[ChatCompaction] Context compacted', {
    agentId: params.agentId,
    originalMessages: params.messages.length,
    compressedMessages: compressed.length,
    originalTokens,
    compressedTokens,
    savedRatio,
  });

  return compressed;
}

async function persistCompactionCheckpoint(params: {
  agentId: string;
  compressedContext: ChatMessage[];
}): Promise<void> {
  await createMessage({
    agentId: params.agentId,
    role: 'TOOL',
    text: 'Context compressed — continuing with summarized history.',
    skipDuplicateToolCheck: true,
    metadata: {
      toolCallId: uuidv4(),
      toolName: 'context_reset',
      toolStatus: 'FINISHED',
      title: 'Context Reset',
      contextCompaction: buildContextCompactionMetadata(params.compressedContext),
    },
  });
}

export async function ensureChatContextWithinBudget(params: {
  agentId: string;
  requestedModel: string;
  rawMessages: ChatMessage[];
  maxContextTokens?: number;
}): Promise<ChatMessage[]> {
  const phaseModels = selectChatPhaseModels(params.requestedModel);
  const compactionModel = phaseModels.router;
  const maxContextTokens = params.maxContextTokens ?? CHAT_MAX_CONTEXT_TOKENS;
  let projected = projectModelContextAfterCompaction(params.rawMessages);
  let consecutiveFailures = 0;

  while (
    shouldAutoCompactChat(projected, maxContextTokens) &&
    consecutiveFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    const beforeTokens = estimateContextTokens(projected);
    try {
      const compressed = await compressChatContext({
        messages: projected,
        model: compactionModel,
        agentId: params.agentId,
      });
      await persistCompactionCheckpoint({
        agentId: params.agentId,
        compressedContext: compressed,
      });
      projected = [...compressed];
      consecutiveFailures = 0;

      const afterTokens = estimateContextTokens(projected);
      log.info('[ChatCompaction] Checkpoint persisted', {
        agentId: params.agentId,
        beforeTokens,
        afterTokens,
        trigger: getAutoCompactThreshold(maxContextTokens),
      });

      if (afterTokens >= beforeTokens) break;
      if (!shouldAutoCompactChat(projected, maxContextTokens)) break;
    } catch (error) {
      consecutiveFailures += 1;
      log.error('[ChatCompaction] Compaction failed', {
        agentId: params.agentId,
        consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  if (
    shouldAutoCompactChat(projected, maxContextTokens) &&
    consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    log.error('[ChatCompaction] Circuit breaker open with context still over trigger', {
      agentId: params.agentId,
      contextTokens: estimateContextTokens(projected),
      trigger: getAutoCompactThreshold(maxContextTokens),
    });
  }

  return projected;
}

export function estimateChatContextTokens(messages: ChatMessage[]): number {
  return estimateContextTokens(messages);
}

export function estimateChatPromptChars(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + (message.text?.length ?? 0), 0);
}

export function estimateChatPromptTokens(messages: ChatMessage[]): number {
  return estimateTokensForCompaction(messages.map((message) => message.text ?? '').join('\n'));
}
