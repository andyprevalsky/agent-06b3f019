/**
 * Chat mode tools - Currently only web_search.
 * Uses Parallel AI's Search API.
 */

export interface WebSearchResult {
  answer: string;
  sources: string[];
}

/**
 * Format Parallel AI search results into a readable answer.
 */
function formatSearchResults(results: any[]): string {
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
  console.log('[WebSearch] Executing search', { query });

  try {
    const apiKey = process.env.PARRALLEL_API_KEY;
    if (!apiKey) {
      throw new Error('PARRALLEL_API_KEY not configured');
    }

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
      throw new Error(`Parallel AI Search API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as { results?: any[] };
    const results = data.results || [];

    // Format results into answer
    const answer = formatSearchResults(results);

    // Extract sources
    const sources = results
      .filter((r: any) => r.url)
      .map((r: any) => r.url);

    console.log('[WebSearch] Search complete', {
      answerLength: answer.length,
      sourceCount: sources.length,
    });

    return {
      answer,
      sources,
    };
  } catch (error) {
    console.error('[WebSearch] Error executing search:', error);

    // Return error message instead of fallback
    return {
      answer: `Unable to search at this time: ${error instanceof Error ? error.message : 'Unknown error'}`,
      sources: [],
    };
  }
}
