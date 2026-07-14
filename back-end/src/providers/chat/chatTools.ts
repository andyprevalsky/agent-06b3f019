/**
 * Chat mode tools - Currently only web_search.
 * Uses Parallel AI's Search API.
 */

import { createLogger } from '../logger';
import { cacheGet, cacheSet } from '../fastCacheStore';
import { goalHash } from '../fastCacheNormalizeCore';
import { webSearchKey } from '../fastCacheNormalizeKeys';
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

async function fetchParallelSearch(
  apiKey: string,
  query: string
): Promise<{ results?: SearchResult[] }> {
  return retryWithBackoff(
    async () => {
      const response = await fetch('https://api.parallel.ai/v1/search', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'turbo',
          objective: query,
          search_queries: [query],
          advanced_settings: {
            max_results: 10,
            excerpt_settings: { max_chars_per_result: 6000 },
          },
        }),
      });

      if (!response.ok) {
        throw new ParallelSearchHttpError(response.status, await response.text());
      }
      return (await response.json()) as { results?: SearchResult[] };
    },
    {
      maxRetries: MAX_RETRIES,
      initialBackoffMs: INITIAL_BACKOFF_MS,
      component: 'ParallelSearch',
      isRetryable: (error) =>
        error instanceof TypeError || (error instanceof ParallelSearchHttpError && error.retryable),
    }
  );
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
      log.info('fast_cache.chat_web_search_hit', { key: cacheKey });
      return hit.value as WebSearchResult;
    }
    log.info('fast_cache.chat_web_search_miss', { key: cacheKey });
  } else if (cacheKey !== null) {
    log.info('fast_cache.chat_web_search_write_only', { key: cacheKey });
  }

  try {
    const apiKey = process.env.PARRALLEL_API_KEY;
    if (!apiKey) {
      throw new Error('PARRALLEL_API_KEY not configured');
    }

    const data = await fetchParallelSearch(apiKey, query);

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
        () => log.info('fast_cache.chat_web_search_stored', { key: cacheKey }),
        (error) =>
          log.warn('fast_cache.chat_web_search_store_failed', {
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
    return {
      answer: `Unable to search at this time: ${error instanceof Error ? error.message : 'Unknown error'}`,
      sources: [],
    };
  }
}
