import type { AgentSpeed, CompletionMessage } from '../rose';
import type { ChatProviderRoute } from './phaseModels';

/** Both chat phases must bind completions to the agent whose evidence they capture. */
export interface ChatCompletionParams {
  agentId: string;
  model: string;
  messages: CompletionMessage[];
  providerRoute?: ChatProviderRoute;
  /** The agent's provider speed; DEMO cache keys never read it. */
  speed: AgentSpeed;
  abortSignal?: AbortSignal;
}
