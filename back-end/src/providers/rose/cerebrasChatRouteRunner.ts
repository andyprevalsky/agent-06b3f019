/**
 * Runs the synchronous Chat generator/router's exclusive Cerebras route and
 * decides whether a failure may fall through to the standard waterfall.
 *
 * Chat is pinned to GLM-4.7 on Cerebras (both the direct and OpenRouter-pinned
 * transports hit Cerebras hardware). The Cerebras org is rate-capped hard —
 * 5 requests/minute across ALL models — so a burst of concurrent chats trips a
 * 402 `quota` (or 429) before any caller-visible content. Rather than sink the
 * chat, a PRE-CONTENT quota/rate-limit error returns `false` so the caller
 * continues into the waterfall (shared GPT / Anthropic / OpenRouter), none of
 * which are subject to the Cerebras cap. Only pre-content quota/rate-limit
 * causes are eligible — a real 4xx/5xx bad request, or any mid-stream error
 * (we cannot re-issue after bytes shipped), still surfaces (fails closed).
 */

import { selectDirectCerebrasFailover } from './directCerebrasFailover';
import { RosePaymentRequiredError, RoseRateLimitError } from './errors';
import { PreContentFallThroughError, runWithFallThrough } from './fallThroughStream';
import { exclusiveOpenRouterCerebrasCompletion } from './openrouterCerebrasRoute';
import { createLogger } from '../logger';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';

const log = createLogger('Rose');

interface ExclusiveCerebrasChatRoute {
  doneEvent: string;
  produce: () => AsyncIterable<RoseStreamChunk>;
}

/**
 * Yields the route's chunks. Returns `true` when the completion finished on
 * Cerebras (the caller should stop), or `false` when Cerebras hit its rate cap
 * pre-content (the caller should fall through to the waterfall).
 */
export async function* runExclusiveCerebrasChatRoute(params: {
  route: ExclusiveCerebrasChatRoute;
  options: CompletionOptions;
  requestId: string;
  callSite?: string;
  pool: string;
  startedAt: number;
  emit: (chunk: RoseStreamChunk) => CompletionChunk | null;
  finalize: (error?: unknown) => void;
}): AsyncGenerator<CompletionChunk, boolean> {
  try {
    yield* runWithFallThrough({ produce: params.route.produce, emit: params.emit });
  } catch (error) {
    const cause = error instanceof PreContentFallThroughError ? error.cause : error;

    // Same-model transport failover (openrouter-cerebras -> direct-cerebras).
    const directFailover = selectDirectCerebrasFailover({
      error,
      options: params.options,
      requestId: params.requestId,
      callSite: params.callSite,
      pool: params.pool,
      startedAt: params.startedAt,
      emit: params.emit,
      finalize: params.finalize,
    });
    if (directFailover) {
      yield* directFailover;
      return true;
    }

    // Only a PRE-CONTENT quota/rate-limit is eligible for fallback — a real
    // 4xx/5xx bad request, or any mid-stream error, still surfaces (fails closed).
    const eligibleForFallback =
      error instanceof PreContentFallThroughError &&
      (cause instanceof RosePaymentRequiredError || cause instanceof RoseRateLimitError);
    if (!eligibleForFallback) {
      params.finalize(cause);
      throw cause;
    }

    // Same-model fallover: keep the chat on GLM-4.7 but reach it via OpenRouter
    // with the provider UNPINNED — OpenRouter still PREFERS Cerebras (`order`)
    // yet may spill to another GLM-4.7 host past the 5-req/min org cap. Preferred
    // over the generic waterfall; only skipped without an OpenRouter key or when
    // the route already IS openrouter-cerebras (avoid a same-transport loop).
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (openrouterKey && params.options.provider_route !== 'openrouter-cerebras') {
      log.warn('cerebras_chat.quota_fallover_to_openrouter_glm', {
        request_id: params.requestId,
        pool: params.pool,
        reason: cause.name,
      });
      try {
        yield* runWithFallThrough({
          produce: () =>
            exclusiveOpenRouterCerebrasCompletion({
              options: params.options,
              openrouterKey,
              requestId: params.requestId,
              callSite: params.callSite,
              allowProviderFallback: true,
            }),
          emit: params.emit,
        });
        log.info('cerebras_chat.openrouter_glm_fallover_done', {
          request_id: params.requestId,
          pool: params.pool,
        });
        params.finalize();
        return true;
      } catch (openRouterError) {
        // A mid-stream failure cannot be re-issued — surface it (fail closed).
        if (!(openRouterError instanceof PreContentFallThroughError)) {
          params.finalize(openRouterError);
          throw openRouterError;
        }
        // GLM-4.7 on OpenRouter also failed pre-content — fall through to the
        // generic waterfall as an absolute last resort (keeps the chat up).
        log.warn('cerebras_chat.openrouter_glm_fallover_failed', {
          request_id: params.requestId,
          pool: params.pool,
          reason: openRouterError.cause.name,
        });
      }
    }

    // Last resort: caller continues into the shared GPT / Anthropic / OpenRouter
    // generic waterfall.
    return false;
  }
  log.info(params.route.doneEvent, {
    request_id: params.requestId,
    pool: params.pool,
    elapsed_ms: Date.now() - params.startedAt,
  });
  params.finalize();
  return true;
}
