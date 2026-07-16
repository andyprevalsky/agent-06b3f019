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
    if (
      error instanceof PreContentFallThroughError &&
      (cause instanceof RosePaymentRequiredError || cause instanceof RoseRateLimitError)
    ) {
      log.warn('cerebras_chat.quota_fallthrough_to_waterfall', {
        request_id: params.requestId,
        pool: params.pool,
        reason: cause.name,
      });
      return false;
    }
    params.finalize(cause);
    throw cause;
  }
  log.info(params.route.doneEvent, {
    request_id: params.requestId,
    pool: params.pool,
    elapsed_ms: Date.now() - params.startedAt,
  });
  params.finalize();
  return true;
}
