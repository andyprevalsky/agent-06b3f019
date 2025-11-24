export const ROSE_MODEL_POOLS = {
  'rose-1-fast': [
    'openai/gpt-oss-120b',
    'qwen/qwen-3-235b-a22b-thinking-2507',
    'moonshotai/kimi-k2-0905',
    'meta-llama/llama-4-maverick',
    'deepseek/deepseek-v3.2-exp',
    'z-ai/glm-4.6',
    'openai/gpt-5.1',
    'mistralai/mistral-medium-3.1',
    'google/gemini-2.5-flash',
    'x-ai/grok-code-fast-1',
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
} as const;

export const ROSE_ALIAS_TO_POOL: Record<string, keyof typeof ROSE_MODEL_POOLS> = {
  'rose-labs/rose-1-fast': 'rose-1-fast',
  'rose-labs/rose-1-ultra': 'rose-1-ultra',
};

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







