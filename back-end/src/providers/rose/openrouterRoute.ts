/**
 * Exclusive OpenRouter waterfall boundary.
 *
 *   explicit route -> require shared key -> pool waterfall -> normalized chunks
 *                         missing key └-> fail closed before any provider call
 */

import type { PoolSpec } from './pools';
import type { CompletionOptions, RoseStreamChunk } from './types';
import { waterfallComplete } from './waterfall';

export function exclusiveOpenRouterWaterfall(params: {
  poolSpec: PoolSpec;
  options: CompletionOptions;
  requestId: string;
  callSite?: string;
}): AsyncIterable<RoseStreamChunk> {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    throw new Error('Rose openrouter-waterfall route requires OPENROUTER_API_KEY');
  }
  return waterfallComplete({
    poolSpec: params.poolSpec,
    messages: params.options.messages,
    responseFormat: params.options.response_format,
    temperature: params.options.temperature,
    maxTokens: params.options.max_tokens,
    openrouterKey,
    requestId: params.requestId,
    callSite: params.callSite,
    providerFastMode: params.options.provider_fast_mode,
    reasoningEffort: params.options.effort,
    abortSignal: params.options.abort_signal,
    tools: params.options.tools,
    anthropicTools: params.options.anthropic_tools,
    toolChoice: params.options.tool_choice,
  });
}
