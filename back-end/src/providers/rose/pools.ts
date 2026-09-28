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
 * rose-1-flash / rose-1-browser-use skip Claude/GPT auth. Primary is
 * Cerebras qwen-3.8-27b (direct). OpenRouter fallback is qwen/qwen3.8-27b
 * then google/gemini-3.8-flash. Planner stays rose-1-ultra (Opus 5.5).
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
  /**
   * When false, skip Claude/GPT OAuth and funded API keys. Default true.
   */
  directAuthEnabled?: boolean;
  /** Bare Cerebras inventory id posted to api.cerebras.ai, not OpenRouter. */
  cerebrasModel?: string;
  cerebrasReasoningEffort?: string;
}

export const POOL_REGISTRY: Record<PoolName, PoolSpec> = {
  'rose-1-mini': {
    name: 'rose-1-mini',
    claudeAuthModel: 'claude-haiku-4-5',
    gptAuthModel: 'gpt-5.6-luna',
    // Haiku stays first so anthropic-family skip tests still have a layer.
    // Second layer is glm-5.3-flash (vision, index 42, TTFT ~0.5s).
    waterfall: ['anthropic/claude-haiku-4.5', 'z-ai/glm-5.3-flash'],
    waterfallReasoningEffort: 'low',
  },
  'rose-1-flash': {
    name: 'rose-1-flash',
    claudeAuthModel: 'claude-sonnet-5',
    gptAuthModel: 'gpt-5.6-luna',
    waterfall: ['qwen/qwen3.8-27b', 'google/gemini-3.8-flash'],
    waterfallReasoningEffort: 'low',
    directAuthEnabled: false,
    cerebrasModel: 'qwen-3.8-27b',
    cerebrasReasoningEffort: 'xhigh',
  },
  'rose-1-ultra': {
    name: 'rose-1-ultra',
    claudeAuthModel: 'claude-opus-5-5',
    gptAuthModel: 'gpt-6-sol',
    // Opus 5.5 leads AA v4.3.2 (58) at $4/$20. Paid waterfall is gpt-6-sol
    // ($2/$10, index 48) then kimi-k3 (index 44).
    waterfall: ['openai/gpt-6-sol', 'moonshotai/kimi-k3'],
  },
  'rose-1-browser-use': {
    name: 'rose-1-browser-use',
    claudeAuthModel: 'claude-sonnet-5',
    gptAuthModel: 'gpt-5.6-luna',
    waterfall: ['qwen/qwen3.8-27b', 'google/gemini-3.8-flash'],
    waterfallReasoningEffort: 'low',
    directAuthEnabled: false,
    cerebrasModel: 'qwen-3.8-27b',
    cerebrasReasoningEffort: 'xhigh',
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
  'rose-fast': 'rose-1-flash',
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
