/**
 * Shared types for the Rose client.
 *
 * Mirrors agents/providers/rose/types.py — same chunk shape so the FE/BE
 * speaks one vocabulary across the Python and TypeScript stacks.
 *
 * The chunk envelope (CompletionChunk) is the OpenAI-shaped DTO that chat
 * callers iterate. RoseStreamChunk is the typed normalized form used inside
 * the orchestration layer.
 */
export type MessageRole = 'system' | 'user' | 'assistant';

export interface ContentBlock {
  type: string;
  text?: string;
  image_url?: { url: string };
  file?: { filename: string; file_data: string };
}

export interface CompletionMessage {
  role: MessageRole;
  content: string | ContentBlock[];
}

export interface ResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };
}

export interface CompletionOptions {
  model: string;
  messages: CompletionMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: ResponseFormat;
  claude_token?: string;
}

/**
 * SSE chunk shape Rose chat callers consume. Identical to what the deleted
 * Supabase edge function emitted, so callers can be repointed without
 * touching their iteration logic.
 */
export interface CompletionChunk {
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      reasoning?: string;
      role?: string;
    };
    finish_reason?: string | null;
  }>;
  requested_model: string;
  actual_model: string;
  pool_name: string;
  pool_size: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Internal normalized stream chunk — analogous to the Python StreamChunk.
 * Producers (claudeAuth/waterfall + parsers) yield these; the client wraps
 * them into the OpenAI-shaped CompletionChunk for chat callers.
 */
export type ChunkKind = 'metadata' | 'content' | 'reasoning' | 'usage' | 'done';

export type RoseStreamChunk =
  | {
      kind: 'metadata';
      data: { actual_model: string; pool_name: string; request_id: string };
    }
  | { kind: 'content'; data: { text: string } }
  | { kind: 'reasoning'; data: { text: string } }
  | {
      kind: 'usage';
      data: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        finish_reason?: string;
      };
    }
  | { kind: 'done'; data: Record<string, never> };
