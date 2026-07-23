import { clearsChatStallGuard, exclusiveCerebrasCompletion } from './cerebrasRoute';
import { RosePaymentRequiredError, RoseRateLimitError } from './errors';
import { PreContentFallThroughError, runWithFallThrough } from './fallThroughStream';
import { hedgeStreams } from './hedgedStream';
import { createLogger } from '../logger';
import { exclusiveOpenRouterCerebrasCompletion } from './openrouterCerebrasRoute';
import { exclusiveOpenRouterFastChatCompletion } from './openrouterFastRoute';
import { exclusiveOpenRouterWaterfall } from './openrouterRoute';
import type { PoolSpec } from './pools';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';

const log = createLogger('Rose');

/**
 * How long the exclusive Cerebras stream may stay silent before the generic
 * waterfall starts IN PARALLEL as a hedge. Shorter than the 1.2s pre-content
 * stall guard, so a throttled/queued Cerebras stream no longer serializes
 * stall detection + waterfall TTFT (which breached the 5s chat lifecycle
 * ratchet). Non-positive values disable hedging (pure serial fallover).
 */
export const DEFAULT_CEREBRAS_CHAT_HEDGE_MS = 800;

function chatHedgeMs(): number {
  const configured = Number(process.env.CEREBRAS_CHAT_HEDGE_MS);
  return Number.isFinite(configured) ? configured : DEFAULT_CEREBRAS_CHAT_HEDGE_MS;
}

interface ExclusiveCerebrasChatRoute {
  doneEvent: string;
  produce: (optionsOverride?: CompletionOptions) => AsyncIterable<RoseStreamChunk>;
}

export function selectExclusiveCerebrasChatRoute(params: {
  options: CompletionOptions;
  requestId: string;
  callSite?: string;
}): ExclusiveCerebrasChatRoute | null {
  if (params.options.provider_route === 'openrouter-cerebras') {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      throw new Error('Rose openrouter-cerebras route requires OPENROUTER_API_KEY');
    }
    return {
      doneEvent: 'openrouter_cerebras.done',
      produce: (optionsOverride) =>
        exclusiveOpenRouterCerebrasCompletion({
          ...params,
          options: optionsOverride ?? params.options,
          openrouterKey,
        }),
    };
  }
  if (params.options.provider_route === 'direct-cerebras') {
    const cerebrasKey = process.env.CEREBRAS_API_KEY;
    if (!cerebrasKey) {
      throw new Error('Rose direct-cerebras route requires CEREBRAS_API_KEY');
    }
    return {
      doneEvent: 'direct_cerebras.done',
      produce: (optionsOverride) =>
        exclusiveCerebrasCompletion({
          ...params,
          options: optionsOverride ?? params.options,
          cerebrasKey,
        }),
    };
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function withBranchAbort(options: CompletionOptions, branchSignal: AbortSignal): CompletionOptions {
  return {
    ...options,
    abort_signal: options.abort_signal
      ? AbortSignal.any([options.abort_signal, branchSignal])
      : branchSignal,
  };
}

/**
 * Race the same-model OpenRouter GLM spill against a paid, low-latency Gemini
 * model. This branch is entered only after direct Cerebras has remained silent
 * long enough to arm the outer hedge, so the normal fast path still makes one
 * provider request. The former Gemini 3.5 fallback took 6–10s to first token
 * under burst; this route's dedicated model keeps the same schema/tool contract
 * with a measured sub-1.4s first-token tail.
 */
export async function* raceDirectCerebrasOpenRouterFallbacks(params: {
  poolSpec: PoolSpec;
  options: CompletionOptions;
  requestId: string;
  callSite?: string;
}): AsyncIterable<RoseStreamChunk> {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    yield* exclusiveOpenRouterWaterfall(params);
    return;
  }

  let winnerName = '';
  const raced = hedgeStreams<RoseStreamChunk>({
    primary: {
      name: 'openrouter-glm',
      produce: (signal) =>
        exclusiveOpenRouterCerebrasCompletion({
          options: withBranchAbort(params.options, signal),
          openrouterKey,
          requestId: params.requestId,
          callSite: params.callSite,
          allowProviderFallback: true,
        }),
    },
    hedge: {
      name: 'openrouter-fast-chat',
      produce: (signal) =>
        exclusiveOpenRouterFastChatCompletion({
          options: withBranchAbort(params.options, signal),
          openrouterKey,
          requestId: params.requestId,
          callSite: params.callSite,
        }),
    },
    // Both branches are already delayed behind the outer Cerebras hedge. Start
    // them together so neither provider's long tail becomes the chat deadline.
    hedgeAfter: () => Promise.resolve(),
    isContent: (chunk) => clearsChatStallGuard(chunk.kind),
    onWinner: (name) => {
      winnerName = name;
    },
  });

  for await (const chunk of raced) yield chunk;
  log.info('cerebras_chat.fallback_race_done', {
    request_id: params.requestId,
    winner: winnerName,
  });
}

/**
 * Run the low-latency Cerebras chat route, and if it produces no caller-visible
 * content before its deadline, race the same-model OpenRouter spill against the
 * REAL multi-provider OpenRouter waterfall. Neither fallback is pinned to the
 * stalled Cerebras host, so a slow or empty provider cannot silence the turn.
 *
 * Once any content has been emitted a new provider cannot be spliced in, so a
 * post-content failure is surfaced to the caller unchanged.
 */
export async function* runCerebrasChatWithWaterfallFallback(params: {
  cerebrasRoute: ExclusiveCerebrasChatRoute;
  poolSpec: PoolSpec;
  options: CompletionOptions;
  requestId: string;
  pool: string;
  callSite?: string;
  startedAt: number;
  emit: (chunk: RoseStreamChunk) => CompletionChunk | null;
}): AsyncIterable<CompletionChunk> {
  // Track caller-visible output so a Cerebras stream that ends CLEANLY without
  // emitting anything (not just one that throws) still falls through instead of
  // returning silence.
  let emittedAny = false;
  const emit = (chunk: RoseStreamChunk): CompletionChunk | null => {
    const output = params.emit(chunk);
    if (output !== null) emittedAny = true;
    return output;
  };

  let cerebrasFailure: unknown = null;
  const hedgeMs = chatHedgeMs();

  if (hedgeMs > 0) {
    // Hedged stage: race Cerebras against the generic waterfall. The hedge only
    // starts after hedgeMs of silence, and only one branch's chunks ever reach
    // the caller, so the fast path costs nothing extra.
    let winnerName = '';
    try {
      const hedged = hedgeStreams<RoseStreamChunk>({
        primary: {
          name: 'cerebras',
          produce: (signal) =>
            params.cerebrasRoute.produce(withBranchAbort(params.options, signal)),
        },
        hedge: {
          name: 'waterfall',
          produce: (signal) =>
            params.options.provider_route === 'direct-cerebras'
              ? raceDirectCerebrasOpenRouterFallbacks({
                  poolSpec: params.poolSpec,
                  options: withBranchAbort(params.options, signal),
                  requestId: params.requestId,
                  callSite: params.callSite,
                })
              : exclusiveOpenRouterWaterfall({
                  poolSpec: params.poolSpec,
                  options: withBranchAbort(params.options, signal),
                  requestId: params.requestId,
                  callSite: params.callSite,
                }),
        },
        hedgeAfter: () => sleep(hedgeMs),
        isContent: (chunk) => clearsChatStallGuard(chunk.kind),
        onWinner: (name) => {
          winnerName = name;
          if (name !== 'cerebras') {
            log.warn('cerebras_chat.hedge_fallback_won', {
              request_id: params.requestId,
              pool: params.pool,
              hedge_ms: hedgeMs,
              elapsed_ms: Date.now() - params.startedAt,
            });
          }
        },
      });
      for await (const chunk of hedged) {
        const output = emit(chunk);
        if (output !== null) yield output;
      }
      if (emittedAny) {
        log.info(
          winnerName === 'cerebras'
            ? params.cerebrasRoute.doneEvent
            : 'cerebras_chat.hedge_fallback.done',
          {
            request_id: params.requestId,
            pool: params.pool,
            elapsed_ms: Date.now() - params.startedAt,
          }
        );
        return;
      }
      log.warn('cerebras_chat.empty_stream_failover_to_waterfall', {
        request_id: params.requestId,
        pool: params.pool,
      });
    } catch (error) {
      if (emittedAny) throw error; // post-content failures surface unchanged
      cerebrasFailure = error;
      log.warn('cerebras_chat.pre_content_failover_to_waterfall', {
        request_id: params.requestId,
        pool: params.pool,
        error_name: error instanceof Error ? error.name : 'unknown',
      });
    }
  } else {
    try {
      yield* runWithFallThrough({ produce: () => params.cerebrasRoute.produce(), emit });
      if (emittedAny) {
        log.info(params.cerebrasRoute.doneEvent, {
          request_id: params.requestId,
          pool: params.pool,
          elapsed_ms: Date.now() - params.startedAt,
        });
        return;
      }
      log.warn('cerebras_chat.empty_stream_failover_to_waterfall', {
        request_id: params.requestId,
        pool: params.pool,
      });
    } catch (error) {
      if (!(error instanceof PreContentFallThroughError)) throw error;
      cerebrasFailure = error.cause;
      log.warn('cerebras_chat.pre_content_failover_to_waterfall', {
        request_id: params.requestId,
        pool: params.pool,
        error_name: error.cause.name,
      });
    }
  }

  // Same-model fallover for a rate cap: GLM-4.7 on Cerebras is capped hard at the
  // org level (5 req/min), so a burst trips a 402 `quota` / 429. Before the
  // generic waterfall (different models), keep the chat on GLM-4.7 by reaching it
  // via OpenRouter with the provider UNPINNED — OpenRouter still PREFERS Cerebras
  // but may spill to another GLM-4.7 host past the cap. This is NOT a
  // same-provider retry (a different host serves it), so it can't re-hit the cap.
  // Only for quota/rate causes; stalls, 5xx, and empty streams go straight to the
  // generic waterfall below.
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (
    openrouterKey &&
    params.options.provider_route !== 'openrouter-cerebras' &&
    (cerebrasFailure instanceof RosePaymentRequiredError ||
      cerebrasFailure instanceof RoseRateLimitError)
  ) {
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
        emit,
      });
      if (emittedAny) {
        log.info('cerebras_chat.openrouter_glm_fallover_done', {
          request_id: params.requestId,
          pool: params.pool,
          elapsed_ms: Date.now() - params.startedAt,
        });
        return;
      }
      log.warn('cerebras_chat.openrouter_glm_fallover_empty', {
        request_id: params.requestId,
        pool: params.pool,
      });
    } catch (openRouterError) {
      if (!(openRouterError instanceof PreContentFallThroughError)) throw openRouterError;
      log.warn('cerebras_chat.openrouter_glm_fallover_failed', {
        request_id: params.requestId,
        pool: params.pool,
        error_name: openRouterError.cause.name,
      });
    }
  }

  yield* runWithFallThrough({
    produce: () =>
      exclusiveOpenRouterWaterfall({
        poolSpec: params.poolSpec,
        options: params.options,
        requestId: params.requestId,
        callSite: params.callSite,
      }),
    emit,
  });
  log.info('cerebras_chat.waterfall_failover.done', {
    request_id: params.requestId,
    pool: params.pool,
    elapsed_ms: Date.now() - params.startedAt,
  });
}
