export const ROSE_MODEL_POOLS = {
  'rose-1-lite': [
    'openai/gpt-oss-120b',
    // 'qwen/qwen3-235b-a22b-thinking-2507', // Disabled - produces garbage tool calls disconnected from reasoning
    'moonshotai/kimi-k2-0905',
    'meta-llama/llama-4-maverick',
    'deepseek/deepseek-v3.2-exp',
    'openai/gpt-5.1',
    'mistralai/mistral-medium-3.1',
    'google/gemini-2.5-flash',
    'nousresearch/hermes-4-405b',
    'minimax/minimax-m2',
    'x-ai/grok-4-fast',
  ],
  'rose-1-ultra': [
    'openai/gpt-5.1',
    'anthropic/claude-sonnet-4.5',
    'moonshotai/kimi-k2-thinking',
    'google/gemini-2.5-pro',
    'x-ai/grok-4-fast',
  ],
  // Cerebras-powered hyper model - direct API calls for ultra-fast inference
  'rose-hyper': [
    'gpt-oss-120b',                    // $0.35 input, $0.75 output per 1M tokens
    'qwen-3-235b-a22b-instruct-2507',  // $0.60 input, $1.20 output per 1M tokens
  ],
} as const;

export const ROSE_ALIAS_TO_POOL: Record<string, keyof typeof ROSE_MODEL_POOLS> = {
  'rose-labs/rose-1-lite': 'rose-1-lite',
  'rose-labs/rose-1-ultra': 'rose-1-ultra',
  'rose-labs/rose-hyper': 'rose-hyper',
};

// Cerebras model pricing (per 1M tokens)
export const CEREBRAS_PRICING = {
  'gpt-oss-120b': {
    prompt: 0.35,      // $0.35 per 1M tokens
    completion: 0.75,  // $0.75 per 1M tokens
  },
  'qwen-3-235b-a22b-instruct-2507': {
    prompt: 0.60,      // $0.60 per 1M tokens
    completion: 1.20,  // $1.20 per 1M tokens
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







