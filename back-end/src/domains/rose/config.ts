/**
 * Rose domain config — constants, defaults, env reads.
 */

// Cerebras API base URL (OpenAI-compatible)
export const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';

// Use local Supabase functions in development, production URL otherwise
export const SUPABASE_FUNCTIONS_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1'
    : `http://localhost:${process.env.RESEARCH_PORT ?? '54321'}/functions/v1`;

export const DEFAULT_CONTEXT_LENGTH = 200000;
