import type { CompletionChunk } from '../rose';
import { cacheGet } from '../fastCacheStore';
import { createLogger } from '../logger';
import { delayedCacheStreamHedge, type CacheLookupResult } from './delayedCacheStreamHedge';

const log = createLogger('GeneratorCacheStream');
export const GENERATOR_CACHE_GRACE_MS = 25;

interface GeneratorCacheStreamOptions {
  agentId: string;
  cacheKey: string;
  createLive: (abortSignal: AbortSignal) => Promise<AsyncIterable<CompletionChunk>>;
  createCached: (json: string) => AsyncIterable<CompletionChunk>;
  onWinner: (winner: 'cache' | 'live') => void;
}

/**
 * Give Fast Mode's optional remote cache a bounded head start, then race it
 * against live generation. No cache network call can gate provider startup.
 */
export function createGeneratorCacheStream(
  options: GeneratorCacheStreamOptions
): AsyncIterable<CompletionChunk> {
  return delayedCacheStreamHedge({
    readCache: async (): Promise<CacheLookupResult<string>> => {
      const hit = await cacheGet(options.cacheKey);
      const json = hit.hit ? (hit.value as { json?: unknown } | null)?.json : undefined;
      if (typeof json === 'string' && json.length > 0) {
        log.info('fast_cache.chat_generator_hit', {
          agentId: options.agentId,
          key: options.cacheKey,
        });
        return { hit: true, value: json };
      }
      log.info('fast_cache.chat_generator_miss', {
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
    graceMs: GENERATOR_CACHE_GRACE_MS,
    onCacheError: (error) =>
      log.warn('fast_cache.chat_generator_read_failed', {
        agentId: options.agentId,
        key: options.cacheKey,
        error: error instanceof Error ? error.message : String(error),
      }),
    onWinner: options.onWinner,
  });
}
