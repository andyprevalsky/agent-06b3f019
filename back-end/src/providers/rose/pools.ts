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
 * Speed pools from a 2026-09-27 live stream bench (TTFT + tok/s, effort low
 * and xhigh, 180-word prompt). gemini-3.1-flash-lite won the vision+tools
 * speed tier (1.19s / 245 tok/s at low). gpt-5.6-luna is the cross-vendor
 * fallback (gpt-6-luna's xhigh TTFT was 20s vs luna's 11s). Speed waterfalls
 * pin effort low so xhigh thinking cannot erase that TTFT. Planner stays ultra.
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
  /**
   * When set, the OpenRouter waterfall stamps this effort instead of the
   * caller / xhigh default. claudeAuth and gptAuth are unchanged.
   */
  waterfallReasoningEffort?: string;
}

export const POOL_REGISTRY: Record<PoolName, PoolSpec> = {
  'rose-1-mini': {
    name: 'rose-1-mini',
    claudeAuthModel: 'claude-haiku-4-5',
    gptAuthModel: 'gpt-5.6-luna',
    // Keep vision-capable layers — challenge classifier sends screenshots.
    // Haiku remains first (fast Anthropic + anthropic-family skip tests).
    // Second layer is the measured speed fallback (gemini-3.1-flash-lite).
    waterfall: ['anthropic/claude-haiku-4.5', 'google/gemini-3.1-flash-lite'],
    waterfallReasoningEffort: 'low',
  },
  'rose-1-flash': {
    name: 'rose-1-flash',
    // Sonnet-5 stays the OAuth primary (Haiku is mini). Paid waterfall is the
    // live-bench speed pair: gemini-3.1-flash-lite then gpt-5.6-luna, effort low.
    claudeAuthModel: 'claude-sonnet-5',
    gptAuthModel: 'gpt-5.6-luna',
    waterfall: ['google/gemini-3.1-flash-lite', 'openai/gpt-5.6-luna'],
    waterfallReasoningEffort: 'low',
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
    waterfall: ['google/gemini-3.1-flash-lite', 'openai/gpt-5.6-luna'],
    waterfallReasoningEffort: 'low',
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
