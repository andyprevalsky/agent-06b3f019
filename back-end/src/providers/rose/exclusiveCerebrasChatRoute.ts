import { clearsChatStallGuard, exclusiveCerebrasCompletion } from './cerebrasRoute';
import { RoseError, RosePaymentRequiredError, RoseRateLimitError, RoseStallError } from './errors';
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
 * How long the exclusive Cerebras stream may stay silent before the OpenRouter
 * fallbacks start IN PARALLEL as a hedge. Cerebras keeps racing them until its
 * own guard, so a throttled/queued or long-prefill Cerebras stream neither
 * serializes stall detection + fallback TTFT (which breached the 5s chat
 * lifecycle ratchet) nor loses a response it was about to send.
 * Non-positive values disable hedging (pure serial fallover).
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

function logBranchFailure(requestId: string, race: string, callerSignal?: AbortSignal) {
  return (branch: string, error: unknown): void => {
    if (callerSignal?.aborted) return;
    log.warn('cerebras_chat.hedge_branch_failed', {
      request_id: requestId,
      race,
      branch,
      error_name: error instanceof Error ? error.name : 'unknown',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    });
  };
}

function withBranchAbort(options: CompletionOptions, branchSignal: AbortSignal): CompletionOptions {
  return {
    ...options,
    abort_signal: options.abort_signal
      ? AbortSignal.any([options.abort_signal, branchSignal])
      : branchSignal,
  };
}

/**
 * Race the paid, low-latency fast chat model against the same-model OpenRouter
 * spill. This branch is entered only after direct Cerebras has failed or stayed
 * silent, so the normal fast path still makes one provider request. The fast
 * model leads: off Cerebras the same Qwen model streams at GPU-host speed
 * (measured 1.6–7.6s to first token). The fast model's guard is sized in
 * openrouterFastRoute.ts. With `latchOnComplete` (structured json_schema
 * replies on the rate-cap path) the first cleanly completed answer wins: a
 * decision is usable only once it closes, so a leg that streams early and then
 * stalls, or stops at its token cap with unclosed JSON (GLM on the router after
 * a Cerebras 429, 2026-11-11), must not lock out a leg that finishes.
 */
export async function* raceDirectCerebrasOpenRouterFallbacks(params: {
  poolSpec: PoolSpec;
  options: CompletionOptions;
  requestId: string;
  callSite?: string;
  hedgeDelayMs?: number;
  latchOnComplete?: boolean;
}): AsyncIterable<RoseStreamChunk> {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    yield* exclusiveOpenRouterWaterfall(params);
    return;
  }

  let winnerName = '';
  const raced = hedgeStreams<RoseStreamChunk>({
    primary: {
      name: 'openrouter-fast-chat',
      produce: (signal) =>
        requireCompletedContent(
          exclusiveOpenRouterFastChatCompletion({
            options: withBranchAbort(params.options, signal),
            openrouterKey,
            requestId: params.requestId,
            callSite: params.callSite,
          }),
          {
            requireCleanStop: params.latchOnComplete === true,
            callerSignal: params.options.abort_signal,
          }
        ),
    },
    hedge: {
      name: 'openrouter-same-model',
      produce: (signal) =>
        requireCompletedContent(
          exclusiveOpenRouterCerebrasCompletion({
            options: withBranchAbort(params.options, signal),
            openrouterKey,
            requestId: params.requestId,
            callSite: params.callSite,
            allowProviderFallback: true,
          }),
          {
            requireCleanStop: params.latchOnComplete === true,
            callerSignal: params.options.abort_signal,
          }
        ),
    },
    // The silent-stream path starts both together. A fast direct 429 uses a
    // short delay so a prompt fast reply wins without an extra request; a fast
    // model that is itself capped hands off to the spill without that wait.
    hedgeAfter: () => (params.hedgeDelayMs ? sleep(params.hedgeDelayMs) : Promise.resolve()),
    hedgeOnPrimaryFailure: true,
    // A structured answer is usable only after its final chunk; plain text and
    // tool-call streams continue at their first content chunk.
    isContent: (chunk) =>
      params.latchOnComplete ? chunk.kind === 'done' : clearsChatStallGuard(chunk.kind),
    onWinner: (name) => {
      winnerName = name;
    },
    onBranchFailure: logBranchFailure(
      params.requestId,
      'openrouter-fallback',
      params.options.abort_signal
    ),
  });

  for await (const chunk of raced) yield chunk;
  log.info('cerebras_chat.fallback_race_done', {
    request_id: params.requestId,
    winner: winnerName,
  });
}

async function* requireCompletedContent(
  stream: AsyncIterable<RoseStreamChunk>,
  opts: { requireCleanStop?: boolean; callerSignal?: AbortSignal } = {}
): AsyncIterable<RoseStreamChunk> {
  let hasContent = false;
  let finishReason: string | undefined;
  try {
    for await (const chunk of stream) {
      if (clearsChatStallGuard(chunk.kind)) hasContent = true;
      if (chunk.kind === 'usage') finishReason = chunk.data.finish_reason;
      // Both failures are classified fall-through errors: when every leg fails,
      // the caller's waterfall runs instead of the turn failing outright.
      if (chunk.kind === 'done' && !hasContent) {
        throw new RoseStallError('OpenRouter fallback completed without content');
      }
      // A structured reply is complete only when the provider reports a normal
      // stop. One cut off at its token cap, or a body that closed without any
      // finish_reason, is unclosed JSON: drop this leg before it can latch, so
      // a cleanly finished leg wins the race.
      if (chunk.kind === 'done' && opts.requireCleanStop && finishReason !== 'stop') {
        throw new RoseStallError(
          `OpenRouter fallback ended without a clean stop (finish_reason=${finishReason ?? 'none'})`
        );
      }
      yield chunk;
    }
  } catch (error) {
    // A structured leg that fails mid-stream for any other reason must still
    // fall through to the waterfall when every leg fails, so classify it.
    // Caller cancellation (the router deadline or a closed turn) propagates unchanged.
    if (!opts.requireCleanStop || error instanceof RoseError || opts.callerSignal?.aborted) {
      throw error;
    }
    throw new RoseStallError(
      `OpenRouter fallback stream failed before completing: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 300)
    );
  }
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
        onBranchFailure: logBranchFailure(
          params.requestId,
          'cerebras-hedge',
          params.options.abort_signal
        ),
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
      // Post-content failures surface unchanged, and a caller that gave up
      // (the router's deadline) must not start the waterfall it abandoned.
      if (emittedAny || params.options.abort_signal?.aborted) throw error;
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
      if (params.options.abort_signal?.aborted) throw error.cause;
      cerebrasFailure = error.cause;
      log.warn('cerebras_chat.pre_content_failover_to_waterfall', {
        request_id: params.requestId,
        pool: params.pool,
        error_name: error.cause.name,
      });
    }
  }

  // A direct 402/429 first tries the fast chat model via OpenRouter. If it
  // remains silent, start the same-model spill too. A fast quota error can
  // otherwise bypass the outer hedge and serialize an unbounded OpenRouter
  // wait (55.8s in production) before the chat has shown any answer.
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
          raceDirectCerebrasOpenRouterFallbacks({
            poolSpec: params.poolSpec,
            options: params.options,
            requestId: params.requestId,
            callSite: params.callSite,
            hedgeDelayMs: 500,
            latchOnComplete: params.options.response_format?.type === 'json_schema',
          }),
        emit,
      });
      if (emittedAny) {
        log.info('cerebras_chat.rate_cap_fallback_done', {
          request_id: params.requestId,
          pool: params.pool,
          elapsed_ms: Date.now() - params.startedAt,
        });
        return;
      }
      log.warn('cerebras_chat.openrouter_rate_fallover_empty', {
        request_id: params.requestId,
        pool: params.pool,
      });
    } catch (openRouterError) {
      if (!(openRouterError instanceof PreContentFallThroughError)) throw openRouterError;
      log.warn('cerebras_chat.openrouter_rate_fallover_failed', {
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
