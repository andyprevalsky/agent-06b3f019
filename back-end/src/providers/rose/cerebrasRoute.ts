/**
 * Exclusive Cerebras boundary for latency-sensitive synchronous Chat.
 *
 *   explicit route -> direct Cerebras rose-fast Qwen stream -> normalized Rose chunks
 *
 * A short first-content deadline protects the synchronous chat budget. This
 * route is exclusive and surfaces every failure to its caller.
 *
 * Model note (2026-09-29): Chat must stay on rose-fast inventory
 * (`qwen-3.8-27b`, same as `POOL_REGISTRY['rose-1-flash'].cerebrasModel`).
 * Older pins (`gemma-4-31b` 404, archived `zai-glm-4.7`, exclusive
 * `gpt-oss-120b`) either miss structured chat or bypass the rose-fast pool.
 * Effort `low` keeps first visible content inside the 5s FE lifecycle ratchet;
 * pool hop elsewhere may use `high`.
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

/** Must match `POOL_REGISTRY['rose-1-flash'].cerebrasModel`. */
export const CEREBRAS_CHAT_MODEL = 'qwen-3.8-27b';
export const CEREBRAS_DIRECT_POOL = 'cerebras-direct';
export const DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS = 1_200;
/** Pool hop (rose-fast Qwen high; Cerebras max) — not the 1.2s chat stall. */
export const POOL_CEREBRAS_IDLE_TIMEOUT_MS = 90_000;
/** Archived Cerebras id — must never be reintroduced as the chat primary. */
export const ARCHIVED_CEREBRAS_CHAT_MODEL = 'zai-glm-4.7';
/** Listed on /models but chat/completions 404s (2026-09-09). */
export const CHAT_DEAD_CEREBRAS_MODEL = 'gemma-4-31b';
/** Former exclusive chat pin — bypassed rose-fast; do not restore. */
export const LEGACY_EXCLUSIVE_CEREBRAS_CHAT_MODEL = 'gpt-oss-120b';
export const CEREBRAS_CHAT_REASONING_EFFORT = 'low';

function chatIdleTimeoutMs(): number {
  const configured = Number(process.env.CEREBRAS_CHAT_IDLE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CEREBRAS_CHAT_IDLE_TIMEOUT_MS;
}

/**
 * Only user-visible output satisfies the chat first-content deadline. This
 * route requests effort `low` so Qwen emits content inside the stall budget.
 * A reasoning trickle is still not progress — counting it kept a silent
 * chat open past the stall guard while the user saw nothing (web_search
 * lifecycle ratchet breach, 2026-07-19).
 */
export function clearsChatStallGuard(kind: RoseStreamChunk['kind']): boolean {
  return kind === 'content' || kind === 'tool_call';
}

function stripCerebrasCacheControl<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripCerebrasCacheControl(item)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'cache_control') continue;
      out[key] = stripCerebrasCacheControl(nested);
    }
    return out as T;
  }
  return value;
}

export function buildCerebrasChatBody(
  options: CompletionOptions,
  model: string = CEREBRAS_CHAT_MODEL,
  reasoningEffort: string = CEREBRAS_CHAT_REASONING_EFFORT
): Record<string, unknown> {
  // Do not send `clear_thinking` — that flag is GLM-only. Gemma-4-31b rejects
  // it with 400 wrong_api_format, which would re-trigger the waterfall path
  // this migration exists to leave.
  // Cerebras also 400s Anthropic/OpenRouter cache_control on content parts
  // (live qwen-3.8-27b 2026-09-28: property unsupported).
  return {
    model,
    messages: stripCerebrasCacheControl(normalizeOpenAiToolCalls(options.messages)),
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: reasoningEffort,
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
  model?: string;
  reasoningEffort?: string;
  idleTimeoutMs?: number;
}): AsyncIterable<RoseStreamChunk> {
  const model = params.model ?? CEREBRAS_CHAT_MODEL;
  const body = buildCerebrasChatBody(
    params.options,
    model,
    params.reasoningEffort ?? CEREBRAS_CHAT_REASONING_EFFORT
  );
  const preTokenTimeoutMs = params.idleTimeoutMs ?? chatIdleTimeoutMs();
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
      actualModel: model,
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
      model,
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
