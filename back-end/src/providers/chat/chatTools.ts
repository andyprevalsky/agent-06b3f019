/**
 * Chat mode tools - Currently only web_search.
 * Uses Parallel AI's Search API.
 */

import { createLogger } from '../logger';
import { cacheGet, cacheSet } from '../demoCacheStore';
import { goalHash } from '../demoCacheNormalizeCore';
import { webSearchKey } from '../demoCacheNormalizeKeys';
import { retryWithBackoff } from '../retry';
import { runCacheWriteInBackground } from './backgroundCacheWrite';

const log = createLogger('WebSearch');

// Retry config
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

export interface WebSearchResult {
  answer: string;
  sources: string[];
}

/**
 * Format Parallel AI search results into a readable answer.
 */
interface SearchResult {
  title?: string;
  snippet?: string;
  url?: string;
  excerpts?: string[];
}

class ParallelSearchHttpError extends Error {
  readonly retryable: boolean;

  constructor(status: number, body: string) {
    super(`Parallel AI Search API error ${status}: ${body}`);
    this.retryable = RETRYABLE_STATUS_CODES.has(status);
  }
}

type ParallelSearchResponse = { results?: SearchResult[] };

// Turbo usually answers in well under a second, but one slow provider response
// alone can exceed the 6s chat lifecycle. A single duplicate request after this
// delay bounds that tail; at most one extra search per turn, only on slow turns.
const PARALLEL_SEARCH_HEDGE_AFTER_MS = 1_500;

async function fetchParallelSearch(
  apiKey: string,
  query: string,
  signal: AbortSignal
): Promise<ParallelSearchResponse> {
  return retryWithBackoff(
    async () => {
      const response = await fetch('https://api.parallel.ai/v1/search', {
        signal,
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'turbo',
          objective: query,
          search_queries: [query],
          // Chat turbo must stay inside the 6s full-lifecycle SLA. 10×6000
          // chars (~18–60KB) made the generator the dominant cost (~3.7s)
          // after a 0.6s Parallel round-trip. Bound excerpts so the compose
          // step stays a snippet summary, not a document rewrite.
          advanced_settings: {
            max_results: 5,
            excerpt_settings: { max_chars_per_result: 800 },
          },
        }),
      });

      if (!response.ok) {
        throw new ParallelSearchHttpError(response.status, await response.text());
      }
      return (await response.json()) as ParallelSearchResponse;
    },
    {
      maxRetries: MAX_RETRIES,
      initialBackoffMs: INITIAL_BACKOFF_MS,
      component: 'ParallelSearch',
      isRetryable: (error) =>
        !signal.aborted &&
        (error instanceof TypeError ||
          (error instanceof ParallelSearchHttpError && error.retryable)),
    }
  );
}

async function fetchParallelSearchHedged(
  apiKey: string,
  query: string
): Promise<ParallelSearchResponse> {
  const primary = new AbortController();
  const primaryRequest = fetchParallelSearch(apiKey, query, primary.signal);
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  const hedgeDue = new Promise<null>((resolve) => {
    hedgeTimer = setTimeout(() => resolve(null), PARALLEL_SEARCH_HEDGE_AFTER_MS);
  });
  try {
    const early = await Promise.race([primaryRequest, hedgeDue]);
    if (early !== null) return early;
  } finally {
    clearTimeout(hedgeTimer);
  }

  log.info('Parallel search hedged', { afterMs: PARALLEL_SEARCH_HEDGE_AFTER_MS });
  const hedge = new AbortController();
  const hedgeRequest = fetchParallelSearch(apiKey, query, hedge.signal);
  try {
    const winner = await Promise.any([
      primaryRequest.then((value) => ({ value, name: 'primary', loser: hedge })),
      hedgeRequest.then((value) => ({ value, name: 'hedge', loser: primary })),
    ]);
    winner.loser.abort();
    log.info('Parallel search hedge settled', { winner: winner.name });
    return winner.value;
  } catch (error) {
    throw error instanceof AggregateError ? error.errors[0] : error;
  }
}

function formatSearchResults(results: SearchResult[]): string {
  if (!results || results.length === 0) {
    return 'No results found.';
  }

  const formattedParts: string[] = [];
  for (const r of results) {
    const title = r.title || '';
    const excerpts = r.excerpts || [];
    const excerptText = Array.isArray(excerpts) ? excerpts.join('\n') : String(excerpts);

    if (title && excerptText) {
      formattedParts.push(`**${title}**\n${excerptText}`);
    } else if (excerptText) {
      formattedParts.push(excerptText);
    }
  }

  return formattedParts.length > 0 ? formattedParts.join('\n\n') : 'No relevant content found.';
}

/**
 * Execute a web search using Parallel AI's Search API.
 * This is the same approach used by the Python implementation.
 */
export async function executeWebSearch(
  query: string,
  fastModeGoal?: string | null,
  fastModeReadEnabled = fastModeGoal !== null && fastModeGoal !== undefined,
  fastModeWriteEnabled = fastModeReadEnabled
): Promise<WebSearchResult> {
  log.info('Executing search', { query });

  const cacheKey =
    fastModeGoal !== null &&
    fastModeGoal !== undefined &&
    (fastModeReadEnabled || fastModeWriteEnabled)
      ? webSearchKey(fastModeGoal, query, 10)
      : null;
  if (cacheKey !== null && fastModeReadEnabled) {
    const hit = await cacheGet(cacheKey);
    if (hit.hit && hit.value) {
      log.info('demo_cache.chat_web_search_hit', { key: cacheKey });
      return hit.value as WebSearchResult;
    }
    log.info('demo_cache.chat_web_search_miss', { key: cacheKey });
  } else if (cacheKey !== null) {
    log.info('demo_cache.chat_web_search_write_only', { key: cacheKey });
  }

  try {
    const apiKey = process.env.PARRALLEL_API_KEY;
    if (!apiKey) {
      throw new Error('PARRALLEL_API_KEY not configured');
    }

    const data = await fetchParallelSearchHedged(apiKey, query);

    const results = data.results || [];

    // Format results into answer
    const answer = formatSearchResults(results);

    // Extract sources
    const sources = results
      .filter((r): r is SearchResult & { url: string } => r.url !== undefined)
      .map((r) => r.url);

    log.info('Search complete', {
      answerLength: answer.length,
      sourceCount: sources.length,
    });

    const result = {
      answer,
      sources,
    };

    if (cacheKey !== null && fastModeGoal && fastModeWriteEnabled) {
      runCacheWriteInBackground(
        () =>
          cacheSet({
            key: cacheKey,
            kind: 'web_search',
            goalHash: goalHash(fastModeGoal),
            value: result,
          }),
        () => log.info('demo_cache.chat_web_search_stored', { key: cacheKey }),
        (error) =>
          log.warn('demo_cache.chat_web_search_store_failed', {
            key: cacheKey,
            error: error instanceof Error ? error.message : String(error),
          })
      );
    }

    return result;
  } catch (error) {
    log.error('Error executing search', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Return error message instead of fallback
    return webSearchErrorResult(error);
  }
}

/** The result a failed search reports in place of its findings. */
export function webSearchErrorResult(error: unknown): WebSearchResult {
  return {
    answer: `Unable to search at this time: ${error instanceof Error ? error.message : 'Unknown error'}`,
    sources: [],
  };
}
