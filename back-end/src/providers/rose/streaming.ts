/**
 * SSE parsing for the Rose client (Anthropic + OpenAI/OpenRouter).
 *
 * Mirrors agents/providers/rose/streaming.py. Both shapes collapse to one
 * normalized AsyncIterable<RoseStreamChunk> beginning with `metadata`,
 * yielding `content` / `reasoning` chunks, then exactly one `usage` chunk
 * and one `done` chunk on clean completion.
 */

import { createLogger } from '../logger';
import { RoseStallError } from './errors';
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

    let event: any;
    try {
      event = JSON.parse(dataStr);
    } catch (err) {
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
      }
      continue;
    }

    if (type === 'error') {
      log.warn('provider_error.anthropic', {
        request_id: options.requestId,
        message: event.error?.message,
        error_type: event.error?.type,
      });
      continue;
    }
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

  let usage: any = {};
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

    let event: any;
    try {
      event = JSON.parse(dataStr);
    } catch (err) {
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
    // eslint-disable-next-line no-restricted-syntax -- explicit per-read idle timeout requires interleaved await
    while (true) {
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: true; value: undefined; stalled: true }>(
        (_, reject) => {
          setTimeout(
            () =>
              reject(
                new RoseStallError(
                  `SSE stream idle for >${idleTimeoutMs}ms (request_id=${requestId})`
                )
              ),
            idleTimeoutMs
          );
        }
      );
      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        yield line;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
