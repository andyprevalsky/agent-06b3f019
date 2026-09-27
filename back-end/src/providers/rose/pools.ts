/**
 * Rose pool registry — single source of truth for backend.
 *
 * Mirrors agents/providers/rose/pools.py exactly. Both stacks share the same
 * model contract; if you change one, change the other.
 *
 * claudeAuth = direct Anthropic Messages API call (user/pool OAuth token).
 * gptAuth    = direct ChatGPT Codex Responses call (user/pool OAuth token).
 * waterfall  = OpenRouter sequential fallback if claudeAuth fails / absent.
 *
 * Speed vs intelligence (2026-09 analysis vs rose-1-ultra / gpt-5.6-sol ~68 t/s):
 *   - Cerebras/Groq gpt-oss-120b: ~500–3000 t/s (chat exclusive route; text-only)
 *   - google/gemini-3.8-flash: ~150–300 t/s, vision+tools, Agentic Index ~40
 *   - openai/gpt-6-luna: fast/cheap OpenAI tier (~70–125 t/s, $0.10/$0.50)
 *   - google/gemini-3.5-flash-lite: lite multimodal (~400 t/s class)
 *   - TypeSafe Jev: Decisions API only (~110–330 ms) — not a chat waterfall model
 * Planner / verifier / param-populator stay on rose-1-ultra (frontier).
 */

export type PoolName = 'rose-1-mini' | 'rose-1-flash' | 'rose-1-ultra' | 'rose-1-browser-use';

/** DAG / approval param-populator always uses ultra, even when the parent agent is flash. */
export const PARAM_POPULATOR_MODEL = 'rose-labs/rose-1-ultra';

export interface PoolSpec {
  name: PoolName;
  /** Anthropic model ID used when a Claude OAuth token is supplied. */
  claudeAuthModel: string;
  /** OpenAI model ID used when a ChatGPT/Codex OAuth token is supplied. */
  gptAuthModel: string;
  /** Provider-prefixed model IDs tried in order if claudeAuth fails. */
  waterfall: readonly string[];
}

export const POOL_REGISTRY: Record<PoolName, PoolSpec> = {
  'rose-1-mini': {
    name: 'rose-1-mini',
    claudeAuthModel: 'claude-haiku-4-5',
    gptAuthModel: 'gpt-5.6-luna',
    // Keep vision-capable layers — challenge classifier sends screenshots.
    // Haiku remains first (fast Anthropic + anthropic-family skip tests).
    waterfall: ['anthropic/claude-haiku-4.5', 'google/gemini-3.5-flash-lite'],
  },
  'rose-1-flash': {
    name: 'rose-1-flash',
    // Sonnet-5 stays the OAuth primary (Haiku is mini). gptAuth drops Terra→Luna
    // for the fast OpenAI tier. Paid waterfall is Gemini 3.8 Flash then GPT-6 Luna
    // — both beat Sol on latency/cost; Kimi K3 stays ultra-only.
    claudeAuthModel: 'claude-sonnet-5',
    gptAuthModel: 'gpt-5.6-luna',
    waterfall: ['google/gemini-3.8-flash', 'openai/gpt-6-luna'],
  },
  'rose-1-ultra': {
    name: 'rose-1-ultra',
    claudeAuthModel: 'claude-fable-5-1',
    gptAuthModel: 'gpt-5.6-sol',
    // claudeAuth is fable 5.1. OpenRouter fable 5.1 is $10/$50 per M vs sol
    // $2/$10, so the paid waterfall stays sol -> kimi.
    waterfall: ['openai/gpt-5.6-sol', 'moonshotai/kimi-k3'],
  },
  'rose-1-browser-use': {
    name: 'rose-1-browser-use',
    // Speed-tier browser pool (not ultra). Both waterfall layers must stay
    // vision-capable (see VISION_MODELS in agents/providers/rose/transforms.py).
    claudeAuthModel: 'claude-sonnet-5',
    gptAuthModel: 'gpt-5.6-luna',
    waterfall: ['google/gemini-3.8-flash', 'openai/gpt-6-luna'],
  },
};

const ALIAS_TO_POOL: Record<string, PoolName> = {
  'rose-labs/rose-1-mini': 'rose-1-mini',
  'rose-labs/rose-1-flash': 'rose-1-flash',
  // Legacy lite → flash (persisted agents / older clients).
  'rose-labs/rose-1-lite': 'rose-1-flash',
  'rose-labs/rose-1-ultra': 'rose-1-ultra',
  'rose-labs/rose-1-browser-use': 'rose-1-browser-use',
  rose: 'rose-1-flash',
  'rose-flash': 'rose-1-flash',
  'rose-lite': 'rose-1-flash',
  'rose-mini': 'rose-1-mini',
  'rose-ultra': 'rose-1-ultra',
  'rose-1-lite': 'rose-1-flash',
  'rose-1-flash': 'rose-1-flash',
};

export function poolForModel(model: string): PoolName | null {
  if (!model) return null;
  const lowered = model.toLowerCase();
  // Only the aliases explicitly listed above resolve. A typo or future
  // identifier like `rose-labs/rose-2` must fall through to "unknown" so the
  // caller can reject it, instead of being silently routed to rose-1-flash.
  if (lowered in ALIAS_TO_POOL) return ALIAS_TO_POOL[lowered];
  return null;
}

export function getPool(name: PoolName): PoolSpec {
  const spec = POOL_REGISTRY[name];
  if (!spec) {
    throw new Error(`Unknown Rose pool ${name} (valid: ${Object.keys(POOL_REGISTRY).join(', ')})`);
  }
  return spec;
}

export function isRoseModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return poolForModel(model) !== null;
}
