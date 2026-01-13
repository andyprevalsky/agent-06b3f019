/**
 * Supabase Completions Client - Calls the Rose Labs completions endpoint
 * This endpoint supports rose-labs/rose-1-lite, rose-labs/rose-1-ultra, etc.
 * and handles model racing internally.
 *
 * Required environment variables:
 * - SUPABASE_URL (defaults to production)
 * - SUPABASE_ANON_KEY
 * - ROSE_API_KEY
 */

// Use local Supabase functions in development, production URL otherwise
const SUPABASE_FUNCTIONS_URL = process.env.NODE_ENV === 'production'
  ? 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1'
  : 'http://localhost:54321/functions/v1';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const ROSE_API_KEY = process.env.ROSE_API_KEY || '';

// Content block for multimodal messages
export interface ContentBlock {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];  // String for text-only, array for multimodal
}

export interface CompletionOptions {
  model: string;
  messages: CompletionMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, any>;
    };
  };
}

export interface CompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Create a streaming completion request to Supabase completions endpoint
 */
export async function createStreamingCompletion(
  options: CompletionOptions
): Promise<AsyncIterable<CompletionChunk>> {
  const url = `${SUPABASE_FUNCTIONS_URL}/completions`;

  // Validate required env vars
  if (!SUPABASE_ANON_KEY) {
    throw new Error('Missing SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY environment variable');
  }
  if (!ROSE_API_KEY) {
    throw new Error('Missing ROSE_API_KEY environment variable');
  }

  const requestBody = {
    ...options,
    stream: true,
    stream_options: { include_usage: true },
  };

  console.log('[SupabaseCompletions] Request to Rose:', JSON.stringify(requestBody, null, 2));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'x-api-key': ROSE_API_KEY,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[SupabaseCompletions] Request failed', {
      status: response.status,
      statusText: response.statusText,
      error: errorText.substring(0, 500),
    });
    throw new Error(`Supabase completions failed: ${response.status} ${errorText}`);
  }

  if (!response.body) {
    throw new Error('No response body from Supabase completions');
  }

  // Return an async iterable that parses SSE events
  return parseSSEStream(response.body);
}

/**
 * Parse SSE stream into completion chunks
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<CompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            return;
          }
          try {
            const chunk = JSON.parse(data) as CompletionChunk;
            yield chunk;
          } catch (e) {
            // Skip invalid JSON (could be partial or debug data)
            console.warn('[SupabaseCompletions] Failed to parse chunk:', data.substring(0, 100));
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
