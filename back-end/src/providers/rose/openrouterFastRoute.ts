/**
 * Fast paid OpenRouter fallback for latency-sensitive synchronous Chat.
 *
 * The normal Rose Lite waterfall intentionally keeps its higher-capability
 * models. This narrow route is only armed after Cerebras stays silent, and
 * preserves the same strict JSON-schema/tool-call contract.
 */

import {
  RoseAuthError,
  RoseError,
  RoseInvalidRequest,
  RosePaymentRequiredError,
  RoseRateLimitError,
  RoseServerError,
  RoseStallError,
} from './errors';
import { clearsChatStallGuard } from './cerebrasRoute';
import { parseOpenAISSE } from './streaming';
import { postOpenRouterStream } from './transport';
import type { CompletionOptions, RoseStreamChunk } from './types';

export const OPENROUTER_FAST_CHAT_MODEL = 'google/gemini-2.5-flash-lite';
export const OPENROUTER_FAST_CHAT_POOL = 'openrouter-fast-chat';
export const DEFAULT_OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS = 2_000;

function chatIdleTimeoutMs(): number {
  const configured = Number(process.env.OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS;
}

export function buildOpenRouterFastChatBody(options: CompletionOptions): Record<string, unknown> {
  return {
    model: OPENROUTER_FAST_CHAT_MODEL,
    messages: options.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
    ...(options.response_format ? { response_format: options.response_format } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.tool_choice !== undefined ? { tool_choice: options.tool_choice } : {}),
  };
}

function openRouterHttpError(status: number, body: string, requestId: string): Error {
  const message = `OpenRouter fast chat ${status} (request_id=${requestId}): ${body.substring(0, 500)}`;
  if (status === 400 || status === 404 || status === 422) return new RoseInvalidRequest(message);
  if (status === 401 || status === 403) return new RoseAuthError(message);
  if (status === 402) return new RosePaymentRequiredError(message);
  if (status === 429) return new RoseRateLimitError(message);
  return new RoseServerError(message);
}

export async function* exclusiveOpenRouterFastChatCompletion(params: {
  options: CompletionOptions;
  openrouterKey: string;
  requestId: string;
  callSite?: string;
}): AsyncIterable<RoseStreamChunk> {
  const preTokenTimeoutMs = chatIdleTimeoutMs();
  const preTokenError = new RoseStallError(
    `OpenRouter fast chat produced no model output within ${preTokenTimeoutMs}ms (request_id=${params.requestId})`
  );
  const preTokenController = new AbortController();
  const requestSignal = params.options.abort_signal
    ? AbortSignal.any([params.options.abort_signal, preTokenController.signal])
    : preTokenController.signal;
  const preTokenTimer = setTimeout(
    () => preTokenController.abort(preTokenError),
    preTokenTimeoutMs
  );
  let emittedMeaningfulChunk = false;

  try {
    const response = await postOpenRouterStream({
      body: buildOpenRouterFastChatBody(params.options),
      openrouterKey: params.openrouterKey,
      requestId: params.requestId,
      callSite: params.callSite,
      abortSignal: requestSignal,
      connectTimeoutMs: preTokenTimeoutMs,
    });
    if (!response.ok) {
      throw openRouterHttpError(response.status, response.errorBody ?? '', params.requestId);
    }
    if (!response.body) {
      throw new RoseStallError(
        `OpenRouter fast chat returned ${response.status} without a stream body`
      );
    }

    for await (const chunk of parseOpenAISSE(response.body, {
      actualModel: OPENROUTER_FAST_CHAT_MODEL,
      poolName: OPENROUTER_FAST_CHAT_POOL,
      requestId: params.requestId,
      idleTimeoutMs: preTokenTimeoutMs,
    })) {
      if (clearsChatStallGuard(chunk.kind)) {
        emittedMeaningfulChunk = true;
        clearTimeout(preTokenTimer);
      }
      yield chunk;
    }
    if (!emittedMeaningfulChunk) {
      throw new RoseStallError(
        `OpenRouter fast chat stream ended without model output (request_id=${params.requestId})`
      );
    }
  } catch (error) {
    if (params.options.abort_signal?.aborted) throw error;
    if (preTokenController.signal.aborted && !emittedMeaningfulChunk) throw preTokenError;
    if (!emittedMeaningfulChunk && !(error instanceof RoseError)) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RoseStallError(
        `OpenRouter fast chat failed before model output (request_id=${params.requestId}): ${detail}`
      );
    }
    throw error;
  } finally {
    clearTimeout(preTokenTimer);
  }
}
