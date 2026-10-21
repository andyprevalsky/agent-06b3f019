/**
 * Chat model selection boundary.
 *
 * requested model ──┬─ router ──> rose-fast via direct-cerebras (or Rose Local)
 *                   ├─ generator ──> rose-fast via direct-cerebras (or Rose Local)
 *                   └─ Temporal ──> persisted requested model (outside this module)
 *
 * `direct-cerebras` selects the exclusive chat hedge path in Rose client; the
 * model on that path is rose-fast Qwen (`CEREBRAS_CHAT_MODEL` = pool
 * cerebrasModel), not the legacy gpt-oss-120b pin. Omitting the route falls
 * through to the 90s/high-effort pool hop and breaches the 5s FE lifecycle
 * ratchet (web_search samples).
 */

import type { CompletionOptions } from '../rose';

/** Display alias rose-fast; pool id rose-1-flash. */
export const ROSE_FAST_MODEL = 'rose-labs/rose-1-flash';

/** Chat-only: arms stall hedge; model remains rose-fast Qwen. */
export const ROSE_FAST_CHAT_PROVIDER_ROUTE = 'direct-cerebras' as const;

export type ChatProviderRoute = NonNullable<CompletionOptions['provider_route']>;

export interface ChatPhaseModels {
  readonly requested: string;
  readonly router: string;
  readonly routerProviderRoute: ChatProviderRoute;
  readonly generator: string;
  readonly generatorProviderRoute: ChatProviderRoute;
}

export function selectChatPhaseModels(requestedModel: string): ChatPhaseModels {
  if (requestedModel === 'rose-labs/rose-local') {
    return {
      requested: requestedModel,
      router: requestedModel,
      routerProviderRoute: 'openrouter-waterfall',
      generator: requestedModel,
      generatorProviderRoute: 'openrouter-waterfall',
    };
  }
  return {
    requested: requestedModel,
    router: ROSE_FAST_MODEL,
    routerProviderRoute: ROSE_FAST_CHAT_PROVIDER_ROUTE,
    generator: ROSE_FAST_MODEL,
    generatorProviderRoute: ROSE_FAST_CHAT_PROVIDER_ROUTE,
  };
}
