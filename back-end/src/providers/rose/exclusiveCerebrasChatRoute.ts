import { exclusiveCerebrasCompletion } from './cerebrasRoute';
import { PreContentFallThroughError, runWithFallThrough } from './fallThroughStream';
import { createLogger } from '../logger';
import { exclusiveOpenRouterCerebrasCompletion } from './openrouterCerebrasRoute';
import { exclusiveOpenRouterWaterfall } from './openrouterRoute';
import type { PoolSpec } from './pools';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';

const log = createLogger('Rose');

interface ExclusiveCerebrasChatRoute {
  doneEvent: string;
  produce: () => AsyncIterable<RoseStreamChunk>;
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
      produce: () => exclusiveOpenRouterCerebrasCompletion({ ...params, openrouterKey }),
    };
  }
  if (params.options.provider_route === 'direct-cerebras') {
    const cerebrasKey = process.env.CEREBRAS_API_KEY;
    if (!cerebrasKey) {
      throw new Error('Rose direct-cerebras route requires CEREBRAS_API_KEY');
    }
    return {
      doneEvent: 'direct_cerebras.done',
      produce: () => exclusiveCerebrasCompletion({ ...params, cerebrasKey }),
    };
  }
  return null;
}

/**
 * Run the low-latency Cerebras chat route, and if it produces no caller-visible
 * content before its deadline, fall through to the REAL multi-provider
 * OpenRouter waterfall (different models) — never a same-model/same-provider
 * retry. A slow or empty Cerebras must never silence the whole chat turn.
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

  try {
    yield* runWithFallThrough({ produce: params.cerebrasRoute.produce, emit });
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
    log.warn('cerebras_chat.pre_content_failover_to_waterfall', {
      request_id: params.requestId,
      pool: params.pool,
      error_name: error.cause.name,
    });
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
