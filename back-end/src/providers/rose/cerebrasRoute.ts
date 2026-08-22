/**
 * Exclusive Cerebras boundary for latency-sensitive synchronous Chat.
 *
 *   explicit route -> direct Cerebras Gemma-4-31B stream -> normalized Rose chunks
 *
 * A short first-content deadline protects the synchronous chat budget. This
 * route is exclusive and surfaces every failure to its caller.
 *
 * Model note (2026-08-20): Cerebras archived `zai-glm-4.7` for our org
 * (`model_archived_error`). Chat then fell through to the OpenRouter
 * waterfall (gemini 400 → kimi-k3 9–30s), which breached the 5s web_search
 * lifecycle ratchet. `gemma-4-31b` is the current Cerebras inventory that
 * still clears the chat latency budget with structured outputs.
 */

import { createLogger } from '../logger';
import {
  RoseAuthError,
  RoseError,
  RoseInvalidRequest,
  RosePaymentRequiredError,
  RoseRateLimitError,
  RoseServerError,
  RoseStallError,
} from './errors';
import { parseOpenAISSE } from './streaming';
import { normalizeOpenAiToolCalls } from './transforms';
import { postCerebrasStream } from './transport';
import type { CompletionOptions, RoseStreamChunk } from './types';

const log = createLogger('CerebrasRoute');

export const CEREBRAS_CHAT_MODEL = 'gemma-4-31b';
export const CEREBRAS_DIRECT_POOL = 'cerebras-direct';
export const DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS = 1_200;
/** Archived Cerebras id — must never be reintroduced as the chat primary. */
export const ARCHIVED_CEREBRAS_CHAT_MODEL = 'zai-glm-4.7';

function chatIdleTimeoutMs(): number {
  const configured = Number(process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS;
}

/**
 * Only user-visible output satisfies the chat first-content deadline. This
 * route requests reasoning_effort 'none', so a reasoning trickle is a
 * throttled/queued stream (e.g. provider rate-cap queuing), not progress —
 * counting it kept a silent chat open past the stall guard while the user
 * saw nothing (web_search lifecycle ratchet breach, 2026-07-19).
 */
export function clearsChatStallGuard(kind: RoseStreamChunk['kind']): boolean {
  return kind === 'content' || kind === 'tool_call';
}

export function buildCerebrasChatBody(options: CompletionOptions): Record<string, unknown> {
  // Do not send `clear_thinking` — that flag is GLM-only. Gemma-4-31b rejects
  // it with 400 wrong_api_format, which would re-trigger the waterfall path
  // this migration exists to leave.
  return {
    model: CEREBRAS_CHAT_MODEL,
    messages: normalizeOpenAiToolCalls(options.messages),
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'none',
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.max_tokens !== undefined ? { max_completion_tokens: options.max_tokens } : {}),
    ...(options.response_format ? { response_format: options.response_format } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.tool_choice !== undefined ? { tool_choice: options.tool_choice } : {}),
  };
}

function cerebrasHttpError(status: number, body: string, requestId: string): Error {
  const message = `Cerebras ${status} (request_id=${requestId}): ${body.substring(0, 500)}`;
  if (status === 400 || status === 404 || status === 422) return new RoseInvalidRequest(message);
  if (status === 401 || status === 403) return new RoseAuthError(message);
  if (status === 402) return new RosePaymentRequiredError(message);
  if (status === 429) return new RoseRateLimitError(message);
  return new RoseServerError(message);
}

export async function* exclusiveCerebrasCompletion(params: {
  options: CompletionOptions;
  cerebrasKey: string;
  requestId: string;
  callSite?: string;
}): AsyncIterable<RoseStreamChunk> {
  const body = buildCerebrasChatBody(params.options);
  const preTokenTimeoutMs = chatIdleTimeoutMs();
  const preTokenError = new RoseStallError(
    `Cerebras produced no model output within ${preTokenTimeoutMs}ms (request_id=${params.requestId})`
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
    const response = await postCerebrasStream({
      body,
      cerebrasKey: params.cerebrasKey,
      requestId: params.requestId,
      callSite: params.callSite,
      abortSignal: requestSignal,
      connectTimeoutMs: preTokenTimeoutMs,
    });

    if (!response.ok) {
      throw cerebrasHttpError(response.status, response.errorBody ?? '', params.requestId);
    }
    if (!response.body) {
      throw new RoseStallError(`Cerebras returned ${response.status} without a stream body`);
    }

    for await (const chunk of parseOpenAISSE(response.body, {
      actualModel: CEREBRAS_CHAT_MODEL,
      poolName: CEREBRAS_DIRECT_POOL,
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
        `Cerebras stream ended without model output (request_id=${params.requestId})`
      );
    }

    log.info('done', {
      request_id: params.requestId,
      call_site: params.callSite,
      model: CEREBRAS_CHAT_MODEL,
    });
  } catch (error) {
    // Preserve caller cancellation and normalize pre-content transport/parser
    // failures into an explicit stall error. No other provider is attempted.
    if (params.options.abort_signal?.aborted) throw error;
    if (preTokenController.signal.aborted && !emittedMeaningfulChunk) throw preTokenError;
    if (!emittedMeaningfulChunk && !(error instanceof RoseError)) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RoseStallError(
        `Cerebras failed before model output (request_id=${params.requestId}): ${detail}`
      );
    }
    throw error;
  } finally {
    clearTimeout(preTokenTimer);
  }
}
