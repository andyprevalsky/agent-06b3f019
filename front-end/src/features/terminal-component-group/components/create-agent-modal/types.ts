export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface CreateAgentSubmitData {
  goal: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  /** Connected repo for the agent's code sessions; omitted = inherit the project's repo. */
  github_repo_ref?: string;
}
