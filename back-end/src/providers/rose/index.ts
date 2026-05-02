/**
 * Rose chat completions provider — direct calls to Anthropic + OpenRouter.
 *
 * Replaces the deleted Supabase /completions edge function. Both this and
 * agents/providers/rose/ share the same model contract (see pools.ts /
 * pools.py). If you change one, change the other.
 */

export { createStreamingCompletion } from './client';
export { markCacheable, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './cache';
export type {
  CompletionChunk,
  CompletionMessage,
  CompletionOptions,
  ContentBlock,
  ResponseFormat,
} from './types';
export {
  RoseAllFailed,
  RoseAuthError,
  RoseDeadlineError,
  RoseError,
  RoseInvalidRequest,
  RoseRateLimitError,
  RoseServerError,
  RoseStallError,
} from './errors';
export { POOL_REGISTRY, getPool, isRoseModel, poolForModel } from './pools';
export type { PoolName, PoolSpec } from './pools';
