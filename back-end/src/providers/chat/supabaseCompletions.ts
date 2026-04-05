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
import { createLogger } from '../logger';
import { logJson } from '../../utils/log';

const log = createLogger('SupabaseCompletions');

const SUPABASE_FUNCTIONS_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1'
    : `http://localhost:${process.env.RESEARCH_PORT || '54321'}/functions/v1`;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const ROSE_API_KEY = process.env.ROSE_API_KEY || '';

// Retry config
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

// Content block for multimodal messages
export interface ContentBlock {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[]; // String for text-only, array for multimodal
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
      schema: Record<string, unknown>;
    };
  };
  claude_token?: string;
}

/**
 * RoseCompletionChunk — canonical SSE shape from Rose completions endpoint.
 * Source of truth: research/supabase/functions/completions/index.ts
 * Python mirror: agents/helpers/rose_types.py
 */
export interface CompletionChunk {
  choices: Array<{
    index: number;
    delta: {
      content?: string; // Text or JSON tokens
      reasoning?: string; // Thinking/reasoning from reasoning-capable models
      role?: string; // Only on first chunk (OpenRouter includes this)
    };
    finish_reason?: string | null; // 'stop' on final content chunk
  }>;
  // Rose metadata — always present on every chunk
  requested_model: string;
  actual_model: string;
  pool_name: string;
  pool_size: number;
  // Token usage — only on the final chunk (when stream_options.include_usage=true)
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

  log.info('Request to Rose', { body: logJson(requestBody) });

  let lastError: Error | null = null;
  // eslint-disable-next-line no-restricted-syntax -- retry is interleaved with SSE stream setup and per-attempt HTTP/network error branching
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'x-api-key': ROSE_API_KEY,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          log.warn(
            `Retryable error ${response.status}, attempt ${attempt}/${MAX_RETRIES}, retrying in ${backoff}ms`
          );
          await new Promise((r) => setTimeout(r, backoff));
          lastError = new Error(`Supabase completions failed: ${response.status} ${errorText}`);
          continue;
        }
        log.error('Request failed', {
          status: response.status,
          statusText: response.statusText,
          error: errorText.substring(0, 500),
        });
        throw new Error(`Supabase completions failed: ${response.status} ${errorText}`);
      }

      if (!response.body) {
        throw new Error('No response body from Supabase completions');
      }

      if (attempt > 1) {
        log.info(`Succeeded on attempt ${attempt}/${MAX_RETRIES}`);
      }

      // Return an async iterable that parses SSE events
      return parseSSEStream(response.body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Retry on network errors (fetch throws on connection refused, timeout, etc.)
      if (attempt < MAX_RETRIES && !lastError.message.startsWith('Supabase completions failed:')) {
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

  throw lastError || new Error('Supabase completions failed after retries');
}

/**
 * Parse SSE stream into completion chunks
 */
async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<CompletionChunk> {
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
          } catch {
            // Skip invalid JSON (could be partial or debug data)
            log.warn('Failed to parse chunk', { data: data.substring(0, 100) });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
