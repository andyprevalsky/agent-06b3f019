/**
 * Exclusive OpenRouter -> Cerebras/Groq boundary for synchronous Chat.
 *
 * The provider constraint is part of the request body, so OpenRouter cannot
 * silently serve the chat model from another host. Provider and model
 * fallbacks are both disabled on the exclusive path; any pre-content failure
 * is surfaced to the caller.
 *
 * Model note (2026-09-29): Align with direct Cerebras chat (`qwen-3.8-27b` /
 * rose-fast). OpenRouter id `qwen/qwen3.8-27b` matches the rose-1-flash
 * waterfall first hop. On org rate-cap fallover the same model may spill to
 * whichever host OpenRouter currently measures fastest.
 */

import {
  RoseAuthError,
  RoseInvalidRequest,
  RosePaymentRequiredError,
  RoseRateLimitError,
  RoseServerError,
  RoseStallError,
} from './errors';
import { OPENROUTER_CHAT_LATENCY_PROVIDER } from './openrouterFastRoute';
import { parseOpenAISSE } from './streaming';
import { openAiChatToolChoice, openAiChatTools } from './toolContract';
import { postOpenRouterStream } from './transport';
import { coerceLeadingOnlySystemMessages, normalizeOpenAiToolCalls } from './transforms';
import type { CompletionOptions, RoseStreamChunk } from './types';

/** Must match rose-1-flash waterfall[0] / direct Cerebras chat inventory. */
export const OPENROUTER_CEREBRAS_MODEL = 'qwen/qwen3.8-27b';
export const OPENROUTER_CEREBRAS_POOL = 'openrouter-cerebras';

export function buildOpenRouterCerebrasBody(
  options: CompletionOptions,
  opts: { allowProviderFallback?: boolean } = {}
): Record<string, unknown> {
  const tools = openAiChatTools(options.tools);
  return {
    model: OPENROUTER_CEREBRAS_MODEL,
    messages: coerceLeadingOnlySystemMessages(normalizeOpenAiToolCalls(options.messages)),
    stream: true,
    stream_options: { include_usage: true },
    // Keep effort low so OpenRouter spill matches the direct-chat stall budget.
    reasoning: { effort: 'low', exclude: true },
    // Default (exclusive route): pin to Cerebras — OpenRouter must not silently
    // serve the chat model from another host. Fallback mode
    // (`allowProviderFallback`): same model, ranked by live latency across its
    // hosts — never a generic waterfall model.
    provider: opts.allowProviderFallback
      ? OPENROUTER_CHAT_LATENCY_PROVIDER
      : { only: ['cerebras'], allow_fallbacks: false, require_parameters: true },
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
    ...(options.response_format ? { response_format: options.response_format } : {}),
    ...(tools ? { tools } : {}),
    ...(tools && options.tool_choice !== undefined
      ? { tool_choice: openAiChatToolChoice(options.tool_choice, OPENROUTER_CEREBRAS_MODEL) }
      : {}),
  };
}

function openRouterCerebrasHttpError(status: number, requestId: string): Error {
  const message = `OpenRouter Cerebras ${status} (request_id=${requestId})`;
  if (status === 400 || status === 404 || status === 422) return new RoseInvalidRequest(message);
  if (status === 401 || status === 403) return new RoseAuthError(message);
  if (status === 402) return new RosePaymentRequiredError(message);
  if (status === 429) return new RoseRateLimitError(message);
  return new RoseServerError(message);
}

export async function* exclusiveOpenRouterCerebrasCompletion(params: {
  options: CompletionOptions;
  openrouterKey: string;
  requestId: string;
  callSite?: string;
  allowProviderFallback?: boolean;
}): AsyncIterable<RoseStreamChunk> {
  const response = await postOpenRouterStream({
    body: buildOpenRouterCerebrasBody(params.options, {
      allowProviderFallback: params.allowProviderFallback,
    }),
    openrouterKey: params.openrouterKey,
    requestId: params.requestId,
    callSite: params.callSite,
    abortSignal: params.options.abort_signal,
  });

  if (!response.ok) {
    throw openRouterCerebrasHttpError(response.status, params.requestId);
  }
  if (!response.body) {
    throw new RoseStallError(
      `OpenRouter Cerebras returned ${response.status} without a stream body`
    );
  }

  yield* parseOpenAISSE(response.body, {
    actualModel: OPENROUTER_CEREBRAS_MODEL,
    poolName: OPENROUTER_CEREBRAS_POOL,
    requestId: params.requestId,
  });
}
