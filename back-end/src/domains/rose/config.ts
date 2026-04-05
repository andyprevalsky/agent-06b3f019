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

export const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const BACKEND_URL = process.env.BACKEND_URL ?? 'https://navi-j9a9.onrender.com';
