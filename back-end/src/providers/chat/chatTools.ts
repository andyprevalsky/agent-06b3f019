/**
 * Chat mode tools - Currently only web_search.
 * Uses Parallel AI's Search API.
 */

import { createLogger } from '../logger';

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
export async function executeWebSearch(query: string): Promise<WebSearchResult> {
  log.info('Executing search', { query });

  try {
    const apiKey = process.env.PARRALLEL_API_KEY;
    if (!apiKey) {
      throw new Error('PARRALLEL_API_KEY not configured');
    }

    let lastError: Error | null = null;
    let data: { results?: SearchResult[] } | null = null;

    // eslint-disable-next-line no-restricted-syntax -- retry is interleaved with per-attempt HTTP status branching and response parsing
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch('https://api.parallel.ai/v1beta/search', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'parallel-beta': 'search-extract-2025-10-10',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            objective: query,
            search_queries: [query],
            max_results: 10,
            excerpts: { max_chars_per_result: 6000 },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          lastError = new Error(`Parallel AI Search API error ${response.status}: ${errorText}`);
          if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
            const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
            log.warn(
              `Retryable error ${response.status}, attempt ${attempt}/${MAX_RETRIES}, retrying in ${backoff}ms`
            );
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw lastError;
        }

        data = (await response.json()) as { results?: SearchResult[] };
        if (attempt > 1) {
          log.info(`Succeeded on attempt ${attempt}/${MAX_RETRIES}`);
        }
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          attempt < MAX_RETRIES &&
          !lastError.message.startsWith('Parallel AI Search API error')
        ) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          log.warn(`Network error, attempt ${attempt}/${MAX_RETRIES}, retrying in ${backoff}ms`, {
            error: lastError.message,
          });
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw lastError;
      }
    }

    if (!data) {
      throw lastError || new Error('Web search failed after retries');
    }

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

    return {
      answer,
      sources,
    };
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
