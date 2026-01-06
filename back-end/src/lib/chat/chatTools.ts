/**
 * Chat mode tools - Currently only web_search.
 * Uses OpenAI's Responses API with web_search tool.
 */

import OpenAI from 'openai';

// OpenAI client for web search (not OpenRouter)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface WebSearchResult {
  answer: string;
  sources: string[];
}

/**
 * Execute a web search using OpenAI's Responses API.
 * This is the same approach used by the Python implementation.
 */
export async function executeWebSearch(query: string): Promise<WebSearchResult> {
  console.log('[WebSearch] Executing search', { query });

  try {
    // Use OpenAI's responses endpoint with web_search tool
    // Note: This is using the newer Responses API
    const response = await openai.responses.create({
      model: 'gpt-4.1',
      tools: [{ type: 'web_search' as any }],  // Type assertion for newer API
      input: query,
    } as any);

    // Extract answer and sources from response
    const answer = (response as any).output_text || '';
    const annotations = (response as any).annotations || [];
    const sources = annotations
      .filter((a: any) => a.url)
      .map((a: any) => a.url);

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

    // Fallback: use regular completion with search context prompt
    const fallbackResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant. The user is asking for current information. Provide what you know, but note that your knowledge may be outdated.',
        },
        {
          role: 'user',
          content: query,
        },
      ],
      temperature: 0.3,
    });

    return {
      answer: fallbackResponse.choices[0]?.message?.content || 'Unable to search at this time.',
      sources: [],
    };
  }
}
