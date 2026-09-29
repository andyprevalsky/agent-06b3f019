/**
 * Chat model selection boundary.
 *
 * requested model ──┬─ router ──> rose-fast (rose-1-flash pool: Cerebras Qwen → waterfall)
 *                   ├─ generator ──> rose-fast (same pool path; no provider_route override)
 *                   └─ Temporal ──> persisted requested model (outside this module)
 *
 * Both synchronous chat phases are latency-sensitive and use the rose-fast pool
 * as-is. Do NOT pin `provider_route: 'direct-cerebras'` here — that exclusive
 * chat route hardcodes gpt-oss-120b and bypasses the pool's cerebrasModel.
 */

import type { CompletionOptions } from '../rose';

/** Display alias rose-fast; pool id rose-1-flash. */
export const ROSE_FAST_MODEL = 'rose-labs/rose-1-flash';

export type ChatProviderRoute = NonNullable<CompletionOptions['provider_route']>;

export interface ChatPhaseModels {
  readonly requested: string;
  readonly router: string;
  /**
   * Omitted on purpose: chat rides the rose-fast pool path (Cerebras Qwen →
   * OpenRouter waterfall). A concrete route here would re-introduce the
   * gpt-oss exclusive chat hop.
   */
  readonly routerProviderRoute?: ChatProviderRoute;
  readonly generator: string;
  readonly generatorProviderRoute?: ChatProviderRoute;
}

export function selectChatPhaseModels(requestedModel: string): ChatPhaseModels {
  return {
    requested: requestedModel,
    router: ROSE_FAST_MODEL,
    generator: ROSE_FAST_MODEL,
  };
}
