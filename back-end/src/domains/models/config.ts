export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const BACKEND_URL = process.env.BACKEND_URL ?? 'https://navi-j9a9.onrender.com';

/** Cache TTL in seconds (1 hour). */
export const MODEL_CACHE_TTL = 3600;

/** Default context length when none is available from the API. */
export const DEFAULT_CONTEXT_LENGTH = 200000;

/** Fallback pricing when calculation fails (per-token strings). */
export const FALLBACK_PRICING = {
  prompt: '0.05',
  completion: '0.10',
} as const;

/**
 * Featured models shown at the top of the list, in exact display order.
 */
export const FEATURED_MODELS = [
  'google/gemini-2.5-flash', // DEFAULT - Fast & capable - 1M context
  'anthropic/claude-sonnet-4.5', // Claude Sonnet 4.5
  'openai/gpt-5-codex', // GPT-5 Codex
  'xai/grok-4-fast', // Grok 4 Fast
  'openai/gpt-oss-20b',
  'z-ai/glm-4.6', // Newest GLM - 200K context
];
