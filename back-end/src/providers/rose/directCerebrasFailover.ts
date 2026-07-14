/** Same-model transport failover for synchronous Chat before visible output. */

import { exclusiveCerebrasCompletion } from './cerebrasRoute';
import { PreContentFallThroughError, runWithFallThrough } from './fallThroughStream';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';
import { createLogger } from '../logger';

const log = createLogger('Rose');

export function selectDirectCerebrasFailover(params: {
  error: unknown;
  options: CompletionOptions;
  requestId: string;
  callSite?: string;
  pool: string;
  startedAt: number;
  emit: (chunk: RoseStreamChunk) => CompletionChunk | null;
  finalize: (error?: unknown) => void;
}): AsyncIterable<CompletionChunk> | null {
  const cerebrasKey = process.env.CEREBRAS_API_KEY;
  if (
    params.options.provider_route !== 'openrouter-cerebras' ||
    !(params.error instanceof PreContentFallThroughError) ||
    !cerebrasKey
  ) {
    return null;
  }

  return runDirectCerebrasFailover(params, cerebrasKey);
}

async function* runDirectCerebrasFailover(
  params: Parameters<typeof selectDirectCerebrasFailover>[0],
  cerebrasKey: string
): AsyncIterable<CompletionChunk> {
  const initialError = (params.error as PreContentFallThroughError).cause;
  log.warn('openrouter_cerebras.pre_content_failover', {
    request_id: params.requestId,
    pool: params.pool,
    error_name: initialError.name,
  });
  try {
    yield* runWithFallThrough({
      produce: () =>
        exclusiveCerebrasCompletion({
          options: { ...params.options, provider_route: 'direct-cerebras' },
          cerebrasKey,
          requestId: params.requestId,
          callSite: params.callSite,
        }),
      emit: params.emit,
    });
  } catch (error) {
    const cause = error instanceof PreContentFallThroughError ? error.cause : error;
    params.finalize(cause);
    throw cause;
  }
  log.info('openrouter_cerebras.direct_failover_done', {
    request_id: params.requestId,
    pool: params.pool,
    elapsed_ms: Date.now() - params.startedAt,
  });
  params.finalize();
}
