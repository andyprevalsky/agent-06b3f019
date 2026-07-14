import { exclusiveCerebrasCompletion } from './cerebrasRoute';
import { exclusiveOpenRouterCerebrasCompletion } from './openrouterCerebrasRoute';
import type { CompletionOptions, RoseStreamChunk } from './types';

interface ExclusiveCerebrasChatRoute {
  doneEvent: string;
  produce: () => AsyncIterable<RoseStreamChunk>;
}

export function selectExclusiveCerebrasChatRoute(params: {
  options: CompletionOptions;
  requestId: string;
  callSite?: string;
}): ExclusiveCerebrasChatRoute | null {
  if (params.options.provider_route === 'openrouter-cerebras') {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      throw new Error('Rose openrouter-cerebras route requires OPENROUTER_API_KEY');
    }
    return {
      doneEvent: 'openrouter_cerebras.done',
      produce: () => exclusiveOpenRouterCerebrasCompletion({ ...params, openrouterKey }),
    };
  }
  if (params.options.provider_route === 'direct-cerebras') {
    const cerebrasKey = process.env.CEREBRAS_API_KEY;
    if (!cerebrasKey) {
      throw new Error('Rose direct-cerebras route requires CEREBRAS_API_KEY');
    }
    return {
      doneEvent: 'direct_cerebras.done',
      produce: () => exclusiveCerebrasCompletion({ ...params, cerebrasKey }),
    };
  }
  return null;
}
