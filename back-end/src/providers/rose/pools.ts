/**
 * Rose pool registry — single source of truth for backend.
 *
 * Mirrors agents/providers/rose/pools.py exactly. Both stacks share the same
 * model contract; if you change one, change the other.
 *
 * claudeAuth = direct Anthropic Messages API call (user/pool OAuth token).
 * gptAuth    = direct ChatGPT Codex Responses call (user/pool OAuth token).
 * waterfall  = OpenRouter sequential fallback if claudeAuth fails / absent.
 */

export type PoolName = 'rose-1-lite' | 'rose-1-ultra' | 'rose-1-browser-use';

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
  'rose-1-lite': {
    name: 'rose-1-lite',
    claudeAuthModel: 'claude-sonnet-5',
    gptAuthModel: 'gpt-5.6-terra',
    waterfall: ['google/gemini-3.5-flash', 'moonshotai/kimi-k3'],
  },
  'rose-1-ultra': {
    name: 'rose-1-ultra',
    claudeAuthModel: 'claude-fable-5',
    gptAuthModel: 'gpt-5.6-sol',
    waterfall: ['anthropic/claude-opus-4.8', 'openai/gpt-5.6-terra'],
  },
  'rose-1-browser-use': {
    name: 'rose-1-browser-use',
    claudeAuthModel: 'claude-fable-5',
    gptAuthModel: 'gpt-5.6-sol',
    waterfall: ['anthropic/claude-opus-4.8', 'openai/gpt-5.6-sol'],
  },
};

const ALIAS_TO_POOL: Record<string, PoolName> = {
  'rose-labs/rose-1-lite': 'rose-1-lite',
  'rose-labs/rose-1-ultra': 'rose-1-ultra',
  'rose-labs/rose-1-browser-use': 'rose-1-browser-use',
  rose: 'rose-1-lite',
  'rose-ultra': 'rose-1-ultra',
};

export function poolForModel(model: string): PoolName | null {
  if (!model) return null;
  const lowered = model.toLowerCase();
  // Only the aliases explicitly listed above resolve. A typo or future
  // identifier like `rose-labs/rose-2` must fall through to "unknown" so the
  // caller can reject it, instead of being silently routed to rose-1-lite.
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
