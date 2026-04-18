/**
 * Completions Domain Configuration
 *
 * All compile-time constants, CORS headers, model pool tables, provider
 * endpoints, and size / latency caps for the Rose completions edge function.
 * Keep values in sync with backend/src/routes/rose.ts.
 */

// ---------------------------------------------------------------------------
// CORS / transport
// ---------------------------------------------------------------------------

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-api-key, x-request-id, x-agent-id, x-call-site',
};

// ---------------------------------------------------------------------------
// Latency racing configuration (TTFT-based)
// ---------------------------------------------------------------------------

export const MAX_LATENCY_CAP_MS = 3000;
export const MAX_DELAY_CAP_MS = 1000;
export const LATENCY_CACHE_TTL_MS = 60000;
export const TRIO_SIZE = 3;
export const LOSER_LATENCY_INCREMENT_MS = 80;

// ---------------------------------------------------------------------------
// Browser-use completion racing caps (completion-based, not TTFT)
// ---------------------------------------------------------------------------

export const BU_MAX_LATENCY_CAP_MS = 30000;
export const BU_MAX_DELAY_CAP_MS = 5000;
export const BU_DEFAULT_LATENCY_MS = 5000;
export const BU_RACE_TIMEOUT_MS = 45000;

// ---------------------------------------------------------------------------
// Model pools (must stay in sync with backend/src/routes/rose.ts)
// ---------------------------------------------------------------------------

export const MODEL_POOLS: Record<string, string[]> = {
  'rose-1-lite': [
    'google/gemini-3-flash-preview',
    'moonshotai/kimi-k2.5',
  ],
  'rose-1-ultra': [
    'anthropic/claude-opus-4.7',
    'google/gemini-3.1-pro-preview',
  ],
  // Browser automation pool - completion-based trio racing
  'rose-1-browser-use': [
    'browser-use',
    'yutori/n1',
    'openai/gpt-5.2',
  ],
};

export const WATERFALL_POOLS = new Set(['rose-1-lite', 'rose-1-ultra']);
export const WATERFALL_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// File-size capability filtering
// ---------------------------------------------------------------------------

export const NO_VISION_MODELS = new Set([
  'moonshotai/kimi-k2-0905',
  'moonshotai/kimi-k2-thinking',
]);

export const MAX_5MB_MODELS = new Set([
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.5',
]);

export const FIVE_MB = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Provider endpoints
// ---------------------------------------------------------------------------

export const BROWSER_USE_API_URL = 'https://llm.api.browser-use.com/v1/chat/completions';
export const YUTORI_API_URL = 'https://api.yutori.com/v1/chat/completions';
export const YUTORI_MODEL = 'n1-latest';
export const ANTHROPIC_CUA_MODEL = 'claude-sonnet-4-20250514';
export const ANTHROPIC_CUA_BETA = 'computer-use-2025-11-24';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_BETA_HEADER = 'structured-outputs-2025-11-13';
export const ANTHROPIC_MAX_ANYOF_BRANCHES = 8;
export const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';

// ---------------------------------------------------------------------------
// Single-model preference lookup table (SMART / FAST / CHEAP)
// ---------------------------------------------------------------------------

export type ModelPreferenceName = 'SMART' | 'FAST' | 'CHEAP';

export const MODEL_PREFERENCES: Record<
  ModelPreferenceName,
  { model: string; isCerebras: boolean }
> = {
  SMART: { model: 'openai/gpt-5.2', isCerebras: false },
  FAST: { model: 'qwen-3-235b-a22b-instruct-2507', isCerebras: true },
  CHEAP: { model: 'google/gemini-2.5-flash', isCerebras: false },
};

// ---------------------------------------------------------------------------
// Vision capability
// ---------------------------------------------------------------------------

export const VISION_CAPABLE_MODELS = new Set([
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-5.2',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-3-pro-preview',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-sonnet-4.6',
  'x-ai/grok-4.1-fast',
  'x-ai/grok-4.1',
]);

// Models that use DOM indices only (browser-use pool)
export const DOM_ONLY_MODELS = ['openai/gpt-5.2', 'anthropic/claude-opus-4.7'];

// ---------------------------------------------------------------------------
// Latency probes
// ---------------------------------------------------------------------------

export const LATENCY_PROBE_MESSAGES = [
  { role: 'user', content: "Reply with just 'ok'" },
];
export const LATENCY_PROBE_MAX_TOKENS = 16;

// ---------------------------------------------------------------------------
// Cost accounting ($/million tokens)
// ---------------------------------------------------------------------------

export const COST_PER_MILLION_INPUT = 0.5;
export const COST_PER_MILLION_OUTPUT = 1.5;

// ---------------------------------------------------------------------------
// Env-backed values
//
// Every env read for this domain goes through a getter in this file so the
// other completions service/repo files stay pure. Mirrors the backend
// `src/domains/*/config.ts` convention.
// ---------------------------------------------------------------------------

/** Hard-coded production Supabase fallback (used when PROD_* env vars are unset
 * in local dev, because the Supabase CLI remaps SUPABASE_URL to the local stack). */
const FALLBACK_PROD_SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co';
const FALLBACK_PROD_SUPABASE_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTg4OTMzNiwiZXhwIjoyMDc1NDY1MzM2fQ.Iff9HtO2szAAKIpOmzGacxMgMZeeqXQfLzQTxrakF9g';

export function getProdSupabaseUrl(): string {
  return Deno.env.get('PROD_SUPABASE_URL') || FALLBACK_PROD_SUPABASE_URL;
}

export function getProdSupabaseServiceKey(): string {
  return Deno.env.get('PROD_SUPABASE_SERVICE_ROLE_KEY') || FALLBACK_PROD_SUPABASE_SERVICE_KEY;
}

export function getOpenRouterApiKey(): string {
  return Deno.env.get('OPENROUTER_API_KEY') ?? '';
}

export function getAnthropicApiKey(): string {
  return Deno.env.get('ANTHROPIC_API_KEY') ?? '';
}

export function getCerebrasApiKey(): string {
  return Deno.env.get('CEREBRAS_API_KEY') ?? '';
}

export function getBrowserUseApiKey(): string {
  return Deno.env.get('BROWSER_USE_API_KEY') ?? '';
}

export function getYutoriApiKey(): string {
  return Deno.env.get('YUTORI_API_KEY') ?? '';
}

export function getBackendApiUrl(): string {
  return Deno.env.get('BACKEND_API_URL') || 'https://navi-j9a9.onrender.com';
}

export function getBackendApiKey(): string {
  return Deno.env.get('BACKEND_API_KEY') ?? '';
}
