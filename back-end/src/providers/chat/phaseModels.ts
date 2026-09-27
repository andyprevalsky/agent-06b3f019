/**
 * Chat model selection boundary.
 *
 * requested model ──┬─ router ──> Rose Flash ──> Cerebras gpt-oss-120b
 *                   ├─ generator ──> Rose Flash ──> Cerebras gpt-oss-120b
 *                   └─ Temporal ──> persisted requested model (outside this module)
 *
 * Both synchronous chat phases are latency-sensitive and use the Rose Flash pool.
 * The persisted requested model remains separate for autonomous Temporal work.
 */

import type { CompletionOptions } from '../rose';

const CHAT_ROUTER_MODEL = 'rose-labs/rose-1-flash';
const CHAT_ROUTER_PROVIDER_ROUTE: NonNullable<CompletionOptions['provider_route']> =
  'direct-cerebras';
const CHAT_GENERATOR_PROVIDER_ROUTE: NonNullable<CompletionOptions['provider_route']> =
  'direct-cerebras';

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
