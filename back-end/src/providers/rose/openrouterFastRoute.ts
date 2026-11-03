/**
 * Fast paid OpenRouter fallback for latency-sensitive synchronous Chat.
 *
 * The normal Rose Flash waterfall intentionally keeps its higher-capability
 * models. This narrow route is only armed after Cerebras stays silent, and
 * preserves the same strict JSON-schema/tool-call contract.
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
import { CHAT_TIMEOUT_MS, clearsChatStallGuard } from './cerebrasRoute';
import { parseOpenAISSE } from './streaming';
import { openAiChatToolChoice, openAiChatTools } from './toolContract';
import { postOpenRouterStream } from './transport';
import { normalizeOpenAiToolCalls } from './transforms';
import type { CompletionOptions, RoseStreamChunk } from './types';

const log = createLogger('Rose');

export const OPENROUTER_FAST_CHAT_MODEL = 'z-ai/glm-5.3-flash';
export const OPENROUTER_FAST_CHAT_POOL = 'openrouter-fast-chat';
/**
 * Pre-token, connect, and SSE-idle bound for this branch. It runs only after
 * direct Cerebras stayed silent, when it is usually the one path that can
 * serve, so it gets the full chat timeout. On real prod router contexts
 * (1k–88k tokens, replayed live 2026-10-01) GLM's first content came 0.4–8.6s
 * after its request; the previous 2s bound aborted responses that would have
 * served.
 */
export const DEFAULT_OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS = CHAT_TIMEOUT_MS;

/**
 * Chat fallbacks must finish a whole structured reply inside the router bound.
 * OpenRouter's default price-weighted balancing lands on slow fp4 hosts,
 * and a static `order` list silently degrades to the first listed endpoint when
 * its hosts cannot serve the request (OpenRouter's Cerebras Qwen host lacks
 * `response_format`/`tools`). Rank hosts by OpenRouter's live 5-minute TTFT
 * percentiles instead, preferring hosts fast enough to stream the JSON, and
 * only among hosts that honor the strict schema/tool parameters.
 */
export const OPENROUTER_CHAT_LATENCY_PROVIDER = {
  sort: 'latency',
  preferred_min_throughput: { p50: 80 },
  // Friendli repeatedly started streaming but missed the 15s router completion
  // bound on the exact production follow-up, despite the throughput preference.
  // InferenceNet accepts strict json_schema but emits keys out of declared order
  // (reasoning, queries, mode, goal, action): the router decides last, after it
  // has written an agent goal, so a direct answer escalated to an agent (2/30
  // replays vs 0/29 on order-keeping hosts), and early action detection never
  // fires (S32, docs/rca/cases/2026-10-28-router-fallback-host-ignores-schema-key-order.md).
  ignore: ['friendli', 'inference-net'],
  allow_fallbacks: true,
  require_parameters: true,
} as const;

function chatIdleTimeoutMs(): number {
  const configured = Number(process.env.OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_OPENROUTER_FAST_CHAT_IDLE_TIMEOUT_MS;
}

const DEFAULT_OPENROUTER_FAST_CHAT_EFFORT = 'xhigh';

function normalizeOpenRouterFastChatEffort(effort?: string): string {
  if (effort === 'minimal') return 'low';
  if (effort === 'max') return 'xhigh';
  return effort ?? DEFAULT_OPENROUTER_FAST_CHAT_EFFORT;
}

/**
 * OpenRouter pins a conversation (keyed by its first messages unless
 * `session_id` is set) to the host that served it for 10 minutes, and `sort`
 * did not override the pin on the e8f2279b profile. A Rose stall abort is not
 * a provider error, so it never releases the pin: without a per-request
 * session the router's regenerate would wait on the same slow host.
 */
export function openRouterFastChatSessionId(requestId: string): string {
  return `rose-fast-chat-${requestId}`;
}

export function buildOpenRouterFastChatBody(
  options: CompletionOptions,
  requestId: string
): Record<string, unknown> {
  const tools = openAiChatTools(options.tools);
  return {
    model: OPENROUTER_FAST_CHAT_MODEL,
    messages: normalizeOpenAiToolCalls(options.messages),
    stream: true,
    stream_options: { include_usage: true },
    session_id: openRouterFastChatSessionId(requestId),
    // Always stamp reasoning.effort so every Rose body builder is well-formed.
    // Callers (chat router/generator) may pass effort:'minimal' for latency;
    // omit → xhigh to match the rest of the Rose surface.
    reasoning: { effort: normalizeOpenRouterFastChatEffort(options.effort) },
    provider: OPENROUTER_CHAT_LATENCY_PROVIDER,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
    ...(options.response_format ? { response_format: options.response_format } : {}),
    ...(tools ? { tools } : {}),
    ...(tools && options.tool_choice !== undefined
      ? { tool_choice: openAiChatToolChoice(options.tool_choice, OPENROUTER_FAST_CHAT_MODEL) }
      : {}),
  };
}

/**
 * One record per failover request, written when it ends for any reason,
 * including a caller abort. The router deadline or a lost hedge race can
 * abort the request before this route's own guard fires and before any SSE
 * event, so neither a branch-failure log nor the host field can record that
 * outcome.
 */
interface FastChatTrace {
  status?: number;
  headers_ms?: number;
  provider?: string;
  first_event_ms?: number;
  first_output_ms?: number;
  first_content_ms?: number;
  end?: 'completed' | 'caller_aborted' | 'consumer_closed' | 'no_output_timeout' | 'failed';
  error_name?: string;
  abort_reason?: string;
}

function abortReason(signal: AbortSignal | undefined): string | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  return (reason instanceof Error ? reason.message : String(reason)).slice(0, 200);
}

function openRouterHttpError(status: number, requestId: string): Error {
  const message = `OpenRouter fast chat ${status} (request_id=${requestId})`;
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
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const trace: FastChatTrace = {};

  try {
    const response = await postOpenRouterStream({
      body: buildOpenRouterFastChatBody(params.options, params.requestId),
      openrouterKey: params.openrouterKey,
      requestId: params.requestId,
      callSite: params.callSite,
      abortSignal: requestSignal,
      connectTimeoutMs: preTokenTimeoutMs,
    });
    trace.status = response.status;
    trace.headers_ms = elapsed();
    if (!response.ok) {
      throw openRouterHttpError(response.status, params.requestId);
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
      onUpstreamProvider: (provider) => {
        trace.provider = provider;
        trace.first_event_ms = elapsed();
      },
    })) {
      if (chunk.kind !== 'metadata') trace.first_output_ms ??= elapsed();
      if (clearsChatStallGuard(chunk.kind)) {
        trace.first_content_ms ??= elapsed();
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
    trace.end = 'completed';
  } catch (error) {
    trace.error_name = error instanceof Error ? error.name : 'unknown';
    if (params.options.abort_signal?.aborted) {
      trace.end = 'caller_aborted';
      throw error;
    }
    if (preTokenController.signal.aborted && !emittedMeaningfulChunk) {
      trace.end = 'no_output_timeout';
      throw preTokenError;
    }
    trace.end = 'failed';
    if (!emittedMeaningfulChunk && !(error instanceof RoseError)) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RoseStallError(
        `OpenRouter fast chat failed before model output (request_id=${params.requestId}): ${detail}`
      );
    }
    throw error;
  } finally {
    clearTimeout(preTokenTimer);
    // A consumer that stops iterating (a lost hedge race) ends the stream
    // without an error reaching this generator.
    trace.end ??= params.options.abort_signal?.aborted ? 'caller_aborted' : 'consumer_closed';
    const reason = abortReason(params.options.abort_signal);
    if (reason !== undefined) trace.abort_reason = reason;
    log.info('openrouter_fast_chat.end', {
      request_id: params.requestId,
      call_site: params.callSite,
      duration_ms: elapsed(),
      ...trace,
    });
  }
}
