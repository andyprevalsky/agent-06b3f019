export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface CreateAgentSubmitData {
  goal: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
}
