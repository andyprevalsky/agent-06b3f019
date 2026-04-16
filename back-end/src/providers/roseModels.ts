// Source of truth: research/supabase/functions/completions/index.ts MODEL_POOLS
// Keep in sync — completions endpoint is the actual routing engine.
export const ROSE_MODEL_POOLS = {
  'rose-1-lite': [
    'google/gemini-3-flash-preview',
    'moonshotai/kimi-k2.5',
  ],
  // Ultra uses claude_token (claude-sonnet-4-6) first, falls back to same pool as lite
  'rose-1-ultra': [
    'google/gemini-3-flash-preview',
    'moonshotai/kimi-k2.5',
  ],
  // Browser automation pool - completion-based trio racing
  'rose-1-browser-use': [
    'browser-use',
    'yutori/n1',
    'openai/gpt-5.2',
  ],
  // Cerebras-powered hyper model - direct API calls for ultra-fast inference
  'rose-hyper': [
    'gpt-oss-120b', // $0.35 input, $0.75 output per 1M tokens
    'qwen-3-235b-a22b-instruct-2507', // $0.60 input, $1.20 output per 1M tokens
  ],
} as const;

export const ROSE_ALIAS_TO_POOL: Record<string, keyof typeof ROSE_MODEL_POOLS> = {
  'rose-labs/rose-1-lite': 'rose-1-lite',
  'rose-labs/rose-1-ultra': 'rose-1-ultra',
  'rose-labs/rose-1-browser-use': 'rose-1-browser-use',
  'rose-labs/rose-hyper': 'rose-hyper',
};

// Cerebras model pricing (per 1M tokens)
export const CEREBRAS_PRICING = {
  'gpt-oss-120b': {
    prompt: 0.35, // $0.35 per 1M tokens
    completion: 0.75, // $0.75 per 1M tokens
  },
  'qwen-3-235b-a22b-instruct-2507': {
    prompt: 0.6, // $0.60 per 1M tokens
    completion: 1.2, // $1.20 per 1M tokens
  },
} as const;

// Check if a model pool uses Cerebras
export function isCerebrasPool(poolName: string): boolean {
  return poolName === 'rose-hyper';
}

export function normalizeRoseAlias(modelId: string): keyof typeof ROSE_MODEL_POOLS | null {
  const lower = modelId.toLowerCase();
  if (ROSE_ALIAS_TO_POOL[lower as keyof typeof ROSE_ALIAS_TO_POOL]) {
    return ROSE_ALIAS_TO_POOL[lower as keyof typeof ROSE_ALIAS_TO_POOL];
  }
  if (lower.startsWith('rose-labs/')) {
    const stripped = lower.replace('rose-labs/', '');
    if (stripped in ROSE_MODEL_POOLS) {
      return stripped as keyof typeof ROSE_MODEL_POOLS;
    }
  }
  return null;
}
