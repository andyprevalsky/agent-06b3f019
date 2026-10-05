import type { CompletionMessage } from '../rose';
import type { ChatProviderRoute } from './phaseModels';

/** Both chat phases must bind completions to the agent whose evidence they capture. */
export interface ChatCompletionParams {
  agentId: string;
  model: string;
  messages: CompletionMessage[];
  providerRoute?: ChatProviderRoute;
  providerFastMode: boolean;
  abortSignal?: AbortSignal;
}
