/**
 * Exclusive OpenRouter -> Cerebras boundary for synchronous Chat.
 *
 * The provider constraint is part of the request body, so OpenRouter cannot
 * silently serve GLM from another host. Provider and model fallbacks are both
 * disabled; any pre-content failure is surfaced to the caller.
 */

import {
  RoseAuthError,
  RoseInvalidRequest,
  RosePaymentRequiredError,
  RoseRateLimitError,
  RoseServerError,
  RoseStallError,
} from './errors';
import { parseOpenAISSE } from './streaming';
import { postOpenRouterStream } from './transport';
import type { CompletionOptions, RoseStreamChunk } from './types';

export const OPENROUTER_CEREBRAS_MODEL = 'z-ai/glm-4.7';
export const OPENROUTER_CEREBRAS_POOL = 'openrouter-cerebras';

export function buildOpenRouterCerebrasBody(options: CompletionOptions): Record<string, unknown> {
  return {
    model: OPENROUTER_CEREBRAS_MODEL,
    messages: options.messages,
    stream: true,
    stream_options: { include_usage: true },
    reasoning: { effort: 'none', exclude: true },
    provider: {
      only: ['cerebras'],
      allow_fallbacks: false,
      require_parameters: true,
    },
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
    ...(options.response_format ? { response_format: options.response_format } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.tool_choice !== undefined ? { tool_choice: options.tool_choice } : {}),
  };
}

function openRouterCerebrasHttpError(status: number, body: string, requestId: string): Error {
  const message = `OpenRouter Cerebras ${status} (request_id=${requestId}): ${body.substring(0, 500)}`;
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
}): AsyncIterable<RoseStreamChunk> {
  const response = await postOpenRouterStream({
    body: buildOpenRouterCerebrasBody(params.options),
    openrouterKey: params.openrouterKey,
    requestId: params.requestId,
    callSite: params.callSite,
    abortSignal: params.options.abort_signal,
  });

  if (!response.ok) {
    throw openRouterCerebrasHttpError(response.status, response.errorBody ?? '', params.requestId);
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
