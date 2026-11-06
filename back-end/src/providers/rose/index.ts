/**
 * Rose chat completions provider — direct calls to Cerebras, Anthropic,
 * OpenAI, and OpenRouter.
 *
 * Replaces the deleted Supabase /completions edge function. Both this and
 * agents/providers/rose/ share the same model contract (see pools.ts /
 * pools.py). If you change one, change the other.
 */

export {
  createStreamingCompletion,
  __resetAnthropicApiKeyCooldown,
  __resetGptApiKeyCooldown,
} from './client';
export { markCacheable, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './cache';
export { buildOpenAiResponseFormat, responseModel, zodToStrictJsonSchema } from './schema';
export type { ZodResponseModel } from './schema';
export type {
  CompletionChunk,
  CompletionMessage,
  CompletionOptions,
  ContentBlock,
  ResponseFormat,
  SubscriptionCredential,
  SubscriptionLeaseFailure,
  SubscriptionLeases,
} from './types';
export {
  RoseAllFailed,
  RoseAuthError,
  RoseDeadlineError,
  RoseError,
  RoseInvalidRequest,
  RoseRefusalError,
  RoseRateLimitError,
  RoseServerError,
  RoseStallError,
} from './errors';
export { POOL_REGISTRY, getPool, isRoseModel, poolForModel } from './pools';
export type { PoolName, PoolSpec } from './pools';
export { StructuredOutputAccumulator, StructuredOutputCardinalityError } from './structuredOutput';
export {
  AGENT_SPEEDS,
  agentSpeedFromRow,
  isAgentSpeed,
  normalizeAgentSpeed,
  anthropicSpeedFor,
  openAiServiceTierFor,
  foundryServiceTierFor,
} from './speed';
export type { AgentSpeed } from './speed';
