/**
 * SSE parsing for the Rose client (Anthropic + OpenAI/OpenRouter).
 *
 * Mirrors agents/providers/rose/streaming.py. Both shapes collapse to one
 * normalized AsyncIterable<RoseStreamChunk> beginning with `metadata`,
 * yielding `content` / `reasoning` chunks, then exactly one `usage` chunk
 * and one `done` chunk on clean completion.
 */

import { createLogger } from '../logger';
import {
  RoseAuthError,
  RoseInvalidRequest,
  RoseRateLimitError,
  RoseRefusalError,
  RoseServerError,
  RoseStallError,
} from './errors';
import type { RoseStreamChunk } from './types';

const log = createLogger('RoseStreaming');

interface ParseOptions {
  actualModel: string;
  poolName: string;
  requestId: string;
  /** Maximum ms between SSE lines before stalling. */
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

function responsesErrorToException(errorPayload: unknown, requestId: string): Error {
  const payload =
    typeof errorPayload === 'object' && errorPayload !== null
      ? (errorPayload as Record<string, unknown>)
      : {};
  const code = String(payload.code ?? payload.type ?? '').toLowerCase();
  const message =
    typeof payload.message === 'string' ? payload.message : JSON.stringify(errorPayload ?? {});
  const details = `Responses stream failed (request_id=${requestId}, code=${code || 'unknown'}): ${message.substring(0, 1000)}`;
  if (['invalid_request_error', 'context_length_exceeded', 'bad_request'].includes(code)) {
    return new RoseInvalidRequest(details);
  }
  if (
    ['refusal', 'safety_refusal', 'content_policy_violation', 'policy_violation'].includes(code)
  ) {
    return new RoseRefusalError(details);
  }
  if (['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests'].includes(code)) {
    return new RoseRateLimitError(details);
  }
  if (['authentication_error', 'permission_error', 'unauthorized', 'forbidden'].includes(code)) {
    return new RoseAuthError(details);
  }
  return new RoseServerError(details);
}

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
  let currentToolId: string | null = null;
  let currentToolName: string | null = null;
  let currentToolArgs: string[] = [];

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
      if (blockType === 'tool_use') {
        currentBlockKind = 'tool_use';
        currentToolId = typeof block.id === 'string' ? block.id : null;
        currentToolName = typeof block.name === 'string' ? block.name : '';
        currentToolArgs = [];
      } else if (blockType === 'text') {
        currentBlockKind = 'text';
      } else if (blockType === 'thinking') {
        currentBlockKind = 'thinking';
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
          yield { kind: 'content', data: { text } };
        }
      } else if (delta.type === 'thinking_delta') {
        const text = delta.thinking ?? '';
        if (text) {
          emittedContentOrTool = true;
          yield { kind: 'reasoning', data: { text } };
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
      currentToolId = null;
      currentToolName = null;
      currentToolArgs = [];
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

  let usage: Record<string, number> = {};
  let finishReason = '';
  let emittedContentOrTool = false;
  let sawDone = false;

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

    const choices = event.choices ?? [];
    if (choices.length === 0) continue;

    const choice = choices[0];
    const delta = choice.delta ?? {};

    const content: string | undefined = delta.content;
    if (content) {
      emittedContentOrTool = true;
      yield { kind: 'content', data: { text: content } };
    }

    const reasoningText: string | undefined = delta.reasoning ?? delta.reasoning_content;
    if (reasoningText) {
      emittedContentOrTool = true;
      yield { kind: 'reasoning', data: { text: reasoningText } };
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
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

  yield {
    kind: 'usage',
    data: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
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
  let cacheReadTokens = 0;
  let finishReason = '';
  let emittedContentOrTool = false;
  let sawDone = false;

  const applyUsage = (usage: Record<string, unknown> | undefined): void => {
    if (!usage) return;
    promptTokens = numberValue(usage.input_tokens) ?? promptTokens;
    completionTokens = numberValue(usage.output_tokens) ?? completionTokens;
    totalTokens = numberValue(usage.total_tokens) ?? totalTokens;
    const details = usage.input_tokens_details as Record<string, unknown> | undefined;
    cacheReadTokens = numberValue(details?.cached_tokens) ?? cacheReadTokens;
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
    const delta = stringValue(event.delta) ?? stringValue(event.text);
    if (
      delta &&
      (type.endsWith('.output_text.delta') ||
        type.endsWith('.text.delta') ||
        type === 'response.output_item.delta')
    ) {
      emittedContentOrTool = true;
      yield { kind: 'content', data: { text: delta } };
      continue;
    }

    const reasoningDelta = reasoningDeltaText(event, type);
    if (reasoningDelta) {
      emittedContentOrTool = true;
      yield { kind: 'reasoning', data: { text: reasoningDelta } };
      continue;
    }

    if (type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined;
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
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheReadTokens,
      finish_reason: finishReason || 'stop',
    },
  };
  yield { kind: 'done', data: {} };
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

/**
 * Read one chunk with an idle-timeout race. The timeout timer is cleared
 * as soon as the read wins so it can't later reject in the background as
 * an unhandled promise rejection.
 */
async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleTimeoutMs: number,
  requestId: string
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new RoseStallError(`SSE stream idle for >${idleTimeoutMs}ms (request_id=${requestId})`)
        ),
      idleTimeoutMs
    );
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Read SSE lines from a ReadableStream, raising RoseStallError if more
 * than `idleTimeoutMs` elapses between consecutive lines.
 */
async function* iterLinesWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
  requestId: string
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const result = await readWithIdleTimeout(reader, idleTimeoutMs, requestId);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        yield line;
      }
    }
    // Truncated streams may close mid-line; yield the remainder so callers
    // don't silently drop diagnostic data on an early provider disconnect.
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
