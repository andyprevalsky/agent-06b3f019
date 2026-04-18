/**
 * Cost domain config: constants, defaults, env-backed values.
 *
 * Layer: config
 * May import from: own types only.
 */

import type { ResolvedPricing } from './types.ts';

/** OpenRouter catalog endpoint. */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Abort OpenRouter catalog fetches after this many milliseconds. */
export const OPENROUTER_TIMEOUT_MS = 10_000;

/** Default HTTP-Referer header value when SUPABASE_URL is not set. */
export const DEFAULT_HTTP_REFERER = 'https://rose-benchmark.supabase.co';

/** X-Title header sent on OpenRouter calls for attribution. */
export const OPENROUTER_X_TITLE = 'Rose Benchmark Suite';

/** Minimum context length returned when no pool model reports one. */
export const DEFAULT_MIN_CONTEXT = 200_000;

/** Rounding granularity for displayed prices (dollars per million tokens). */
export const PRICE_ROUNDING_STEP_USD = 0.05;

/** CORS headers applied to every response from this domain. */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Model pools for Rose variants.
 * Source of truth: completions/index.ts MODEL_POOLS (kept in sync manually).
 */
export const MODEL_POOLS: Record<string, string[]> = {
  'rose-1-lite': [
    'google/gemini-3-flash-preview',
    'moonshotai/kimi-k2.5',
  ],
  // Ultra uses claude_token (claude-sonnet-4-6) first, falls back to Opus 4.7 → Gemini 3.1 Pro.
  'rose-1-ultra': [
    'anthropic/claude-opus-4.7',
    'google/gemini-3.1-pro-preview',
  ],
  // Browser automation pool - completion-based trio racing.
  'rose-1-browser-use': [
    'browser-use',
    'yutori/n1',
    'openai/gpt-5.2',
  ],
};

/**
 * Fixed per-token pricing for all pool models (sourced from OpenRouter catalog).
 * Having all models here means we never need to call OpenRouter at request time.
 */
export const FIXED_PRICING: Record<string, ResolvedPricing> = {
  'google/gemini-3-flash-preview': {
    prompt: 0.50 / 1_000_000,
    completion: 3.00 / 1_000_000,
    contextLength: 1_048_576,
  },
  'moonshotai/kimi-k2.5': {
    prompt: 0.38 / 1_000_000,
    completion: 1.72 / 1_000_000,
    contextLength: 262_144,
  },
  'anthropic/claude-opus-4.7': {
    prompt: 5.00 / 1_000_000,
    completion: 25.00 / 1_000_000,
    contextLength: 1_000_000,
  },
  'google/gemini-3.1-pro-preview': {
    prompt: 2.00 / 1_000_000,
    completion: 12.00 / 1_000_000,
    contextLength: 1_048_576,
  },
  'openai/gpt-5.2': {
    prompt: 1.75 / 1_000_000,
    completion: 14.00 / 1_000_000,
    contextLength: 400_000,
  },
  'browser-use': {
    prompt: 0.10 / 1_000_000,
    completion: 0.40 / 1_000_000,
    contextLength: 128_000,
  },
  'yutori/n1': {
    // Yutori direct API — not on OpenRouter.
    prompt: 0.75 / 1_000_000,
    completion: 3.00 / 1_000_000,
    contextLength: 128_000,
  },
};
