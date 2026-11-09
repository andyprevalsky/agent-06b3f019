import type { AgentSpeed, CompletionMessage } from '../rose';
import type { ChatProviderRoute } from './phaseModels';

/** Both chat phases must bind completions to the agent whose evidence they capture. */
export interface ChatCompletionParams {
  agentId: string;
  rootAgentId?: string;
  model: string;
  messages: CompletionMessage[];
  providerRoute?: ChatProviderRoute;
  /** The agent's provider speed; DEMO cache keys never read it. */
  speed: AgentSpeed;
  abortSignal?: AbortSignal;
}

export interface ChatLlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  model: string;
  from_fast_cache: boolean;
}

export function emptyChatLlmUsage(): ChatLlmUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    model: '',
    from_fast_cache: false,
  };
}

export function applyChunkUsage(
  target: ChatLlmUsage,
  chunkUsage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }
): void {
  target.prompt_tokens = chunkUsage.prompt_tokens ?? 0;
  target.completion_tokens = chunkUsage.completion_tokens ?? 0;
  target.total_tokens = chunkUsage.total_tokens ?? 0;
  target.cache_creation_input_tokens = chunkUsage.cache_creation_input_tokens ?? 0;
  target.cache_read_input_tokens = chunkUsage.cache_read_input_tokens ?? 0;
}

export function accumulateChatLlmUsage(target: ChatLlmUsage, increment: ChatLlmUsage): void {
  target.prompt_tokens += increment.prompt_tokens;
  target.completion_tokens += increment.completion_tokens;
  target.total_tokens += increment.total_tokens;
  target.cache_creation_input_tokens += increment.cache_creation_input_tokens;
  target.cache_read_input_tokens += increment.cache_read_input_tokens;
}
