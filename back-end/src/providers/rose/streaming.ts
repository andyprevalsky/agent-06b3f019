/**
 * SSE parsing for the Rose client (Anthropic + OpenAI/OpenRouter).
 *
 * Mirrors agents/providers/rose/streaming.py. Both shapes collapse to one
 * normalized AsyncIterable<RoseStreamChunk> beginning with `metadata`,
 * yielding `content` / `reasoning` chunks, then exactly one `usage` chunk
 * and one `done` chunk on clean completion.
 */

import { createLogger } from '../logger';
import { RoseRefusalError, RoseStallError } from './errors';
import { responsesErrorToException } from './responsesErrors';
import { responsesOutputProvenance, type ResponsesOutputProvenance } from './streamProvenance';
import type { RoseStreamChunk } from './types';
import { createReasoningDetailsCollector } from './reasoningDetails';
import { iterLinesWithIdleTimeout } from './sseLines';

const log = createLogger('RoseStreaming');

interface ParseOptions {
  actualModel: string;
  poolName: string;
  requestId: string;
  /** Maximum ms between SSE lines before stalling. */
  idleTimeoutMs?: number;
  /** Called once with OpenRouter's top-level `provider` (the serving host). */
  onUpstreamProvider?: (provider: string) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * Anthropic native SSE → normalized chunks.
 */
export async function* parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
  options: ParseOptions
): AsyncIterable<RoseStreamChunk> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  yield {
    kind: 'metadata',
    data: {
      actual_model: options.actualModel,
      pool_name: options.poolName,
      request_id: options.requestId,
    },
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let finishReason = '';
  let emittedContentOrTool = false;

  // Per-content-block state. Anthropic streams blocks one-at-a-time so a
  // single mutable slot is sufficient.
  let currentBlockKind: 'text' | 'thinking' | 'tool_use' | null = null;
  let currentBlockIndex = 0;
  let currentToolId: string | null = null;
  let currentToolName: string | null = null;
  let currentToolArgs: string[] = [];
  // Thinking text + signature are needed to replay the turn (archive only).
  let currentThinking: string[] = [];
  let currentSignature: string | null = null;

  const stopReasonMap: Record<string, string> = {
    end_turn: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
  };

  for await (const line of iterLinesWithIdleTimeout(body, idleTimeoutMs, options.requestId)) {
    if (!line) continue;
    if (line.startsWith('event: ')) continue;
    if (!line.startsWith('data: ')) continue;

    const dataStr = line.slice(6);
    if (dataStr === '[DONE]') break;

    let event;
    try {
      event = JSON.parse(dataStr);
    } catch {
      log.warn('parse_error.anthropic', {
        request_id: options.requestId,
        snippet: dataStr.substring(0, 200),
      });
      continue;
    }

    const type = event.type;

    if (type === 'message_start') {
      const usage = event.message?.usage ?? {};
      inputTokens = usage.input_tokens ?? 0;
      cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
      cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      continue;
    }

    if (type === 'message_delta') {
      const usage = event.usage ?? {};
      if (usage.output_tokens) outputTokens = usage.output_tokens;
      const stopReason = event.delta?.stop_reason;
      if (stopReason) finishReason = stopReasonMap[stopReason] ?? stopReason;
      continue;
    }

    if (type === 'content_block_start') {
      const block = event.content_block ?? {};
      const blockType = block.type;
      currentBlockIndex = numberValue(event.index) ?? 0;
      if (blockType === 'tool_use') {
        currentBlockKind = 'tool_use';
        currentToolId = typeof block.id === 'string' ? block.id : null;
        currentToolName = typeof block.name === 'string' ? block.name : '';
        currentToolArgs = [];
      } else if (blockType === 'text') {
        currentBlockKind = 'text';
      } else if (blockType === 'thinking') {
        currentBlockKind = 'thinking';
        currentThinking =
          typeof block.thinking === 'string' && block.thinking ? [block.thinking] : [];
        currentSignature =
          typeof block.signature === 'string' && block.signature ? block.signature : null;
      } else if (blockType === 'redacted_thinking') {
        currentBlockKind = null;
        yield {
          kind: 'reasoning_block',
          data: {
            type: 'anthropic_redacted_thinking',
            data: typeof block.data === 'string' ? block.data : null,
          },
        };
      } else {
        currentBlockKind = null;
      }
      continue;
    }

    if (type === 'content_block_delta') {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta') {
        const text = delta.text ?? '';
        if (text) {
          emittedContentOrTool = true;
          yield {
            kind: 'content',
            data: {
              text,
              item_id: `anthropic:${currentBlockIndex}`,
              output_index: currentBlockIndex,
              content_index: 0,
              phase: 'final_answer',
            },
          };
        }
      } else if (delta.type === 'signature_delta') {
        if (typeof delta.signature === 'string') {
          currentSignature = (currentSignature ?? '') + delta.signature;
        }
      } else if (delta.type === 'thinking_delta') {
        const text = delta.thinking ?? '';
        if (text) {
          currentThinking.push(text);
          emittedContentOrTool = true;
          yield {
            kind: 'reasoning',
            data: {
              text,
              item_id: `anthropic:${currentBlockIndex}`,
              output_index: currentBlockIndex,
              content_index: 0,
              phase: 'reasoning',
            },
          };
        }
      } else if (delta.type === 'input_json_delta') {
        const fragment = delta.partial_json ?? '';
        if (fragment) {
          currentToolArgs.push(fragment);
        }
      }
      continue;
    }

    if (type === 'content_block_stop') {
      if (currentBlockKind === 'thinking') {
        yield {
          kind: 'reasoning_block',
          data: {
            type: 'anthropic_thinking',
            text: currentThinking.join(''),
            signature: currentSignature,
          },
        };
      }
      if (currentBlockKind === 'tool_use' && currentToolName !== null) {
        emittedContentOrTool = true;
        yield {
          kind: 'tool_call',
          data: {
            id: currentToolId ?? '',
            name: currentToolName,
            arguments: currentToolArgs.join(''),
          },
        };
      }
      currentBlockKind = null;
      currentBlockIndex = 0;
      currentToolId = null;
      currentToolName = null;
      currentToolArgs = [];
      currentThinking = [];
      currentSignature = null;
      continue;
    }

    if (type === 'error') {
      log.warn('provider_error.anthropic', {
        request_id: options.requestId,
        message: event.error?.message,
        error_type: event.error?.type,
      });
      throw responsesErrorToException(event.error, options.requestId);
    }
  }

  if (finishReason === 'refusal') {
    throw new RoseRefusalError(
      `Anthropic stream ended with refusal (request_id=${options.requestId})`
    );
  }

  if (!emittedContentOrTool) {
    throw new RoseStallError(
      `Anthropic stream closed without content (request_id=${options.requestId})`
    );
  }

  yield {
    kind: 'usage',
    data: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens,
      finish_reason: finishReason,
    },
  };
  yield { kind: 'done', data: {} };
}

/**
 * OpenAI / OpenRouter SSE → normalized chunks.
 */
export async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
  options: ParseOptions
): AsyncIterable<RoseStreamChunk> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  yield {
    kind: 'metadata',
    data: {
      actual_model: options.actualModel,
      pool_name: options.poolName,
      request_id: options.requestId,
    },
  };

  let usage: Record<string, unknown> = {};
  let finishReason = '';
  let emittedContentOrTool = false;
  let sawDone = false;
  let reportedUpstreamProvider = false;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  const flushedToolIndices = new Set<number>();
  const reasoningDetails = createReasoningDetailsCollector();

  const flushToolCalls = (): RoseStreamChunk[] => {
    const chunks: RoseStreamChunk[] = [];
    for (const index of [...toolCalls.keys()].sort((left, right) => left - right)) {
      if (flushedToolIndices.has(index)) continue;
      const toolCall = toolCalls.get(index)!;
      chunks.push({ kind: 'tool_call', data: { ...toolCall } });
      flushedToolIndices.add(index);
    }
    return chunks;
  };

  for await (const line of iterLinesWithIdleTimeout(body, idleTimeoutMs, options.requestId)) {
    if (!line || !line.startsWith('data: ')) continue;
    const dataStr = line.slice(6);
    if (dataStr === '[DONE]') {
      sawDone = true;
      break;
    }

    let event;
    try {
      event = JSON.parse(dataStr);
    } catch {
      log.warn('parse_error.openai', {
        request_id: options.requestId,
        snippet: dataStr.substring(0, 200),
      });
      continue;
    }

    if (event.usage) usage = event.usage;
    if (typeof event.provider === 'string' && !reportedUpstreamProvider) {
      reportedUpstreamProvider = true;
      options.onUpstreamProvider?.(event.provider);
    }

    const choices = event.choices ?? [];
    if (choices.length === 0) continue;

    const choice = choices[0];
    const delta = choice.delta ?? {};
    const choiceIndex = numberValue(choice.index) ?? 0;

    const content: string | undefined = delta.content;
    if (content) {
      emittedContentOrTool = true;
      yield {
        kind: 'content',
        data: {
          text: content,
          item_id: `openai:choice:${choiceIndex}`,
          output_index: choiceIndex,
          content_index: 0,
          phase: 'final_answer',
        },
      };
    }

    reasoningDetails.add(delta.reasoning_details);

    const reasoningText: string | undefined = delta.reasoning ?? delta.reasoning_content;
    if (reasoningText) {
      emittedContentOrTool = true;
      yield {
        kind: 'reasoning',
        data: {
          text: reasoningText,
          item_id: `openai:choice:${choiceIndex}`,
          output_index: choiceIndex,
          content_index: 0,
          phase: 'reasoning',
        },
      };
    }

    for (const toolDelta of delta.tool_calls ?? []) {
      const index = numberValue(toolDelta.index) ?? 0;
      const slot = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof toolDelta.id === 'string' && toolDelta.id) slot.id = toolDelta.id;
      const fn = toolDelta.function ?? {};
      if (typeof fn.name === 'string' && fn.name) slot.name = fn.name;
      if (typeof fn.arguments === 'string' && fn.arguments) slot.arguments += fn.arguments;
      toolCalls.set(index, slot);
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
      for (const chunk of flushToolCalls()) {
        emittedContentOrTool = true;
        yield chunk;
      }
    }
  }

  for (const chunk of flushToolCalls()) {
    emittedContentOrTool = true;
    yield chunk;
  }

  if (finishReason === 'refusal') {
    throw new RoseRefusalError(
      `OpenAI/OpenRouter stream ended with refusal (request_id=${options.requestId})`
    );
  }

  if (!emittedContentOrTool) {
    throw new RoseStallError(
      `OpenAI/OpenRouter stream closed without content ` +
        `(request_id=${options.requestId}, saw_done=${sawDone})`
    );
  }

  for (const block of reasoningDetails.blocks()) yield { kind: 'reasoning_block', data: block };
  yield {
    kind: 'usage',
    data: {
      prompt_tokens: numberValue(usage.prompt_tokens) ?? 0,
      completion_tokens: numberValue(usage.completion_tokens) ?? 0,
      total_tokens: numberValue(usage.total_tokens) ?? 0,
      cache_creation_input_tokens:
        numberValue(usage.cache_creation_input_tokens) ??
        numberValue(
          (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cache_write_tokens
        ) ??
        0,
      cache_read_input_tokens:
        numberValue(usage.cache_read_input_tokens) ??
        numberValue(
          (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens
        ) ??
        0,
      ...optionalReasoningTokens(
        numberValue(
          (usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens
        ) ?? numberValue(usage.reasoning_tokens)
      ),
      finish_reason: finishReason,
    },
  };
  yield { kind: 'done', data: {} };
}

/**
 * OpenAI Responses API SSE → normalized chunks.
 *
 * Codex's ChatGPT-account backend streams Responses events, not Chat
 * Completions chunks. We accept the public Responses event names plus a few
 * conservative aliases because the Codex backend can expose newer event
 * variants before the public docs settle.
 */
export async function* parseResponsesSSE(
  body: ReadableStream<Uint8Array>,
  options: ParseOptions
): AsyncIterable<RoseStreamChunk> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  yield {
    kind: 'metadata',
    data: {
      actual_model: options.actualModel,
      pool_name: options.poolName,
      request_id: options.requestId,
    },
  };

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cacheWriteTokens = 0;
  let cacheWriteReported = false;
  let cacheReadTokens = 0;
  let reasoningTokens: number | undefined;
  let finishReason = '';
  let emittedContentOrTool = false;
  let sawDone = false;
  const outputItems = new Map<string, ResponsesOutputProvenance>();

  const applyUsage = (usage: Record<string, unknown> | undefined): void => {
    if (!usage) return;
    promptTokens = numberValue(usage.input_tokens) ?? promptTokens;
    completionTokens = numberValue(usage.output_tokens) ?? completionTokens;
    totalTokens = numberValue(usage.total_tokens) ?? totalTokens;
    const details = usage.input_tokens_details as Record<string, unknown> | undefined;
    const reportedWrites = numberValue(details?.cache_write_tokens);
    if (reportedWrites !== undefined) {
      // GPT-5.6+ reports writes; zero is a real value once breakpoints apply.
      cacheWriteTokens = reportedWrites;
      cacheWriteReported = true;
    }
    cacheReadTokens = numberValue(details?.cached_tokens) ?? cacheReadTokens;
    const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
    reasoningTokens = numberValue(outputDetails?.reasoning_tokens) ?? reasoningTokens;
  };

  for await (const line of iterLinesWithIdleTimeout(body, idleTimeoutMs, options.requestId)) {
    if (!line) continue;
    if (line.startsWith('event: ')) continue;
    if (!line.startsWith('data: ')) continue;
    const dataStr = line.slice(6);
    if (dataStr === '[DONE]') {
      sawDone = true;
      break;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      log.warn('parse_error.responses', {
        request_id: options.requestId,
        snippet: dataStr.substring(0, 200),
      });
      continue;
    }

    const type = String(event.type ?? '');
    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined;
      const itemId = stringValue(item?.id);
      if (itemId) {
        const itemType = stringValue(item?.type);
        outputItems.set(itemId, {
          item_id: itemId,
          output_index: numberValue(event.output_index) ?? 0,
          content_index: 0,
          phase:
            stringValue(item?.phase) ?? (itemType === 'reasoning' ? 'reasoning' : 'final_answer'),
        });
      }
      continue;
    }

    const delta = stringValue(event.delta) ?? stringValue(event.text);
    if (
      delta &&
      (type.endsWith('.output_text.delta') ||
        type.endsWith('.text.delta') ||
        type === 'response.output_item.delta')
    ) {
      emittedContentOrTool = true;
      yield {
        kind: 'content',
        data: {
          text: delta,
          ...responsesOutputProvenance(event, outputItems, 'final_answer'),
        },
      };
      continue;
    }

    const reasoningDelta = reasoningDeltaText(event, type);
    if (reasoningDelta) {
      emittedContentOrTool = true;
      yield {
        kind: 'reasoning',
        data: {
          text: reasoningDelta,
          ...responsesOutputProvenance(event, outputItems, 'reasoning'),
        },
      };
      continue;
    }

    if (type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined;
      const itemId = stringValue(item?.id);
      if (itemId && !outputItems.has(itemId)) {
        const itemType = stringValue(item?.type);
        outputItems.set(itemId, {
          item_id: itemId,
          output_index: numberValue(event.output_index) ?? 0,
          content_index: 0,
          phase:
            stringValue(item?.phase) ?? (itemType === 'reasoning' ? 'reasoning' : 'final_answer'),
        });
      }
      if (item?.type === 'reasoning') {
        const encryptedContent = stringValue(item.encrypted_content);
        if (encryptedContent) {
          yield {
            kind: 'codex_reasoning_item',
            data: {
              id: item.id,
              encrypted_content: encryptedContent,
              summary: Array.isArray(item.summary) ? item.summary : [],
            },
          };
          continue;
        }
        // Unencrypted reasoning items are not replayable, but their summary is
        // part of the trajectory the archive must keep.
        yield {
          kind: 'reasoning_block',
          data: {
            type: 'openai_reasoning_item',
            id: stringValue(item.id) ?? null,
            summary: Array.isArray(item.summary) ? item.summary : [],
            raw: item,
          },
        };
        continue;
      }
      if (item?.type === 'function_call') {
        emittedContentOrTool = true;
        yield {
          kind: 'tool_call',
          data: {
            id: stringValue(item.call_id) ?? stringValue(item.id) ?? '',
            name: stringValue(item.name) ?? '',
            arguments: stringValue(item.arguments) ?? '',
          },
        };
        continue;
      }
    }

    if (type === 'response.completed') {
      const response = event.response as Record<string, unknown> | undefined;
      applyUsage(response?.usage as Record<string, unknown> | undefined);
      finishReason = 'stop';
      continue;
    }

    if (type === 'response.incomplete') {
      const response = event.response as Record<string, unknown> | undefined;
      applyUsage(response?.usage as Record<string, unknown> | undefined);
      finishReason = 'length';
      continue;
    }

    if (type === 'error' || type === 'response.failed') {
      let errorPayload = event.error;
      if (!errorPayload && typeof event.response === 'object' && event.response !== null) {
        errorPayload = (event.response as Record<string, unknown>).error;
      }
      log.warn('provider_error.responses', {
        request_id: options.requestId,
        type,
        error_payload: JSON.stringify(errorPayload ?? {}).substring(0, 1000),
      });
      throw responsesErrorToException(errorPayload, options.requestId);
    }
  }

  if (!emittedContentOrTool) {
    throw new RoseStallError(
      `Responses stream closed without content or tool_call ` +
        `(request_id=${options.requestId}, saw_done=${sawDone})`
    );
  }

  yield {
    kind: 'usage',
    data: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens || promptTokens + completionTokens,
      cache_creation_input_tokens: cacheWriteReported
        ? cacheWriteTokens
        : Math.max(promptTokens - cacheReadTokens, 0),
      cache_read_input_tokens: cacheReadTokens,
      ...optionalReasoningTokens(reasoningTokens),
      finish_reason: finishReason || 'stop',
    },
  };
  yield { kind: 'done', data: {} };
}

/** Present only when the provider reported it (keeps the shared chunk contract stable). */
function optionalReasoningTokens(value: number | undefined): { reasoning_tokens?: number } {
  return value === undefined ? {} : { reasoning_tokens: value };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reasoningDeltaText(event: Record<string, unknown>, type: string): string | undefined {
  if (!type.includes('reasoning')) return undefined;
  if (type.endsWith('.delta')) {
    return (
      stringValue(event.delta) ?? stringValue(event.summary_text) ?? stringValue(event.reasoning)
    );
  }
  return stringValue(event.summary_text) ?? stringValue(event.reasoning);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
