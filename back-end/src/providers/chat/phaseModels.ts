/**
 * Chat model selection boundary.
 *
 * requested model ──┬─ router ──> Rose Lite ──> OpenRouter ──> Cerebras GLM-4.7
 *                   ├─ generator ──> Rose Lite ──> OpenRouter ──> Cerebras GLM-4.7
 *                   └─ Temporal ──> persisted requested model (outside this module)
 *
 * Both synchronous chat phases are latency-sensitive and use the Rose Lite pool.
 * The persisted requested model remains separate for autonomous Temporal work.
 */

import type { CompletionOptions } from '../rose';

const CHAT_ROUTER_MODEL = 'rose-labs/rose-1-lite';
const CHAT_ROUTER_PROVIDER_ROUTE: NonNullable<CompletionOptions['provider_route']> =
  'openrouter-cerebras';
const CHAT_GENERATOR_PROVIDER_ROUTE: NonNullable<CompletionOptions['provider_route']> =
  'openrouter-cerebras';

export type ChatProviderRoute = NonNullable<CompletionOptions['provider_route']>;

export interface ChatPhaseModels {
  readonly requested: string;
  readonly router: string;
  readonly routerProviderRoute: ChatProviderRoute;
  readonly generator: string;
  readonly generatorProviderRoute: ChatProviderRoute;
}

export function selectChatPhaseModels(requestedModel: string): ChatPhaseModels {
  return {
    requested: requestedModel,
    router: CHAT_ROUTER_MODEL,
    routerProviderRoute: CHAT_ROUTER_PROVIDER_ROUTE,
    generator: CHAT_ROUTER_MODEL,
    generatorProviderRoute: CHAT_GENERATOR_PROVIDER_ROUTE,
  };
}
