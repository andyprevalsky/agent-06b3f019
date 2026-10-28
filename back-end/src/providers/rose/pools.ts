/**
 * Rose pool registry — single source of truth for backend.
 *
 * Mirrors agents/providers/rose/pools.py exactly. Both stacks share the same
 * model contract; if you change one, change the other.
 *
 * claudeAuth = direct Anthropic Messages API call (user/pool OAuth token).
 * gptAuth    = direct ChatGPT Codex Responses call (user/pool OAuth token).
 * foundry    = funded Azure fallback for the pool's gptAuthModel (GPT-6.1 Sol for
 *              ultra, GPT-6 Luna for flash, GPT-5.6 Luna for mini/browser-use). It follows
 *              direct credentials and the direct Cerebras hop.
 * waterfall  = OpenRouter sequential fallback after the direct routes.
 *
 * rose-1-flash / rose-1-browser-use skip Claude/GPT auth. Primary is
 * Cerebras qwen-3.8-27b (direct). OpenRouter fallback is qwen/qwen3.8-27b
 * then google/gemini-3.8-flash. Flash tries Foundry GPT-6 Luna at medium first;
 * browser-use retains GPT-5.6 Luna.
 * Planner stays rose-1-ultra (Opus 5.5).
 */

export type PoolName =
  'rose-1-mini' | 'rose-1-flash' | 'rose-1-ultra' | 'rose-1-browser-use' | 'rose-local';

export interface PoolSpec {
  name: PoolName;
  /** Anthropic model ID used when a Claude OAuth token is supplied. */
  claudeAuthModel: string;
  /** OpenAI model ID used when a ChatGPT/Codex OAuth token is supplied. */
  gptAuthModel: string;
  /**
   * Try gptAuthModel on Microsoft Foundry (funded Azure) after direct
   * credentials and the Cerebras hop, before OpenRouter. directAuthEnabled
   * does not gate it.
   */
  foundryEnabled?: boolean;
  /**
   * Pins the pool to this Foundry model (no stand-ins). Unset, Foundry serves
   * gptAuthModel and any Sol deployment serves a Sol pool. Mirror: pools.py.
   */
  foundryModel?: string;
  /** Provider-prefixed model IDs tried in order if claudeAuth fails. */
  waterfall: readonly string[];
  /**
   * When set, the OpenRouter waterfall and the Foundry fallback stamp this
   * effort instead of the caller / xhigh default. claudeAuth and gptAuth are
   * unchanged.
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
  'rose-local': {
    name: 'rose-local',
    // Inert required fields: the local branch returns before any remote leg.
    claudeAuthModel: 'claude-opus-5-5',
    gptAuthModel: 'gpt-6-sol',
    waterfall: [],
    directAuthEnabled: false,
  },
  'rose-1-mini': {
    name: 'rose-1-mini',
    claudeAuthModel: 'claude-haiku-4-5',
    gptAuthModel: 'gpt-5.6-luna',
    foundryEnabled: true,
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
    // Azure and OpenRouter Qwen/Gemini fallbacks all run at medium.
    waterfallReasoningEffort: 'medium',
    directAuthEnabled: false,
    cerebrasModel: 'qwen-3.8-27b',
    cerebrasReasoningEffort: 'high',
    foundryEnabled: true,
    // Azure serves GPT-6 Luna only (never the 5.6 Luna gptAuthModel), in
    // whichever regions list a gpt-6-luna deployment.
    foundryModel: 'gpt-6-luna',
  },
  'rose-1-ultra': {
    name: 'rose-1-ultra',
    claudeAuthModel: 'claude-opus-5-5',
    gptAuthModel: 'gpt-6.1-sol',
    foundryEnabled: true,
    foundryModel: 'gpt-6.1-sol',
    // Opus 5.5 leads AA v4.3.2 (58) at $4/$20. Paid waterfall is gpt-6.1-sol
    // then kimi-k3.
    waterfall: ['openai/gpt-6.1-sol', 'moonshotai/kimi-k3'],
  },
  'rose-1-browser-use': {
    name: 'rose-1-browser-use',
    claudeAuthModel: 'claude-sonnet-5',
    gptAuthModel: 'gpt-5.6-luna',
    waterfall: ['qwen/qwen3.8-27b', 'google/gemini-3.8-flash'],
    waterfallReasoningEffort: 'low',
    directAuthEnabled: false,
    cerebrasModel: 'qwen-3.8-27b',
    cerebrasReasoningEffort: 'high',
    foundryEnabled: true,
  },
};

const ALIAS_TO_POOL: Record<string, PoolName> = {
  'rose-labs/rose-1-mini': 'rose-1-mini',
  'rose-labs/rose-1-flash': 'rose-1-flash',
  // Legacy lite → flash (persisted agents / older clients).
  'rose-labs/rose-1-lite': 'rose-1-flash',
  'rose-labs/rose-1-ultra': 'rose-1-ultra',
  'rose-labs/rose-1-browser-use': 'rose-1-browser-use',
  'rose-labs/rose-local': 'rose-local',
  'rose-local': 'rose-local',
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
