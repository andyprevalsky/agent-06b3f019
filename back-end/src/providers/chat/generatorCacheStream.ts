import type { CompletionChunk } from '../rose';
import { cacheGet } from '../demoCacheStore';
import { isOaiDemoGoal } from '../demoCacheNormalizeOaiDemo';
import { createLogger } from '../logger';
import { delayedCacheStreamHedge, type CacheLookupResult } from './delayedCacheStreamHedge';

const log = createLogger('GeneratorCacheStream');
export const GENERATOR_CACHE_HANG_MS = 5_000;

interface GeneratorCacheStreamOptions {
  agentId: string;
  cacheKey: string;
  createLive: (abortSignal: AbortSignal) => Promise<AsyncIterable<CompletionChunk>>;
  createCached: (json: string) => AsyncIterable<CompletionChunk>;
  onWinner: (winner: 'cache' | 'live') => void;
  goal?: string | null;
}

/**
 * Fast Mode read waits for the cache lookup before starting Cerebras.
 * A remote shared-cache hit (~1s) must not lose to a faster live first token
 * (~500ms); that race recorded gemma-4-31b usage and broke zero-live replay.
 * A hang timeout still starts live if the cache never resolves.
 */
export function createGeneratorCacheStream(
  options: GeneratorCacheStreamOptions
): AsyncIterable<CompletionChunk> {
  return delayedCacheStreamHedge({
    readCache: async (): Promise<CacheLookupResult<string>> => {
      const hit = await cacheGet(options.cacheKey);
      const json = hit.hit ? (hit.value as { json?: unknown } | null)?.json : undefined;
      if (typeof json === 'string' && json.length > 0) {
        log.info('demo_cache.chat_generator_hit', {
          agentId: options.agentId,
          key: options.cacheKey,
        });
        return { hit: true, value: json };
      }
      log.info('demo_cache.chat_generator_miss', {
        agentId: options.agentId,
        key: options.cacheKey,
      });
      return { hit: false };
    },
    createLive: options.createLive,
    createCached: options.createCached,
    isLiveCommitChunk: (chunk) => {
      const delta = chunk.choices[0]?.delta;
      return Boolean(delta?.content?.length || delta?.reasoning?.length);
    },
    awaitCacheFirst: isOaiDemoGoal(options.goal),
    hangTimeoutMs: GENERATOR_CACHE_HANG_MS,
    onCacheError: (error) =>
      log.warn('demo_cache.chat_generator_read_failed', {
        agentId: options.agentId,
        key: options.cacheKey,
        error: error instanceof Error ? error.message : String(error),
      }),
    onWinner: options.onWinner,
  });
}
