export interface WorldModelAction {
  kind: 'tool_call' | 'message';
  name?: string | null;
  arguments?: Record<string, unknown>;
  content?: string | null;
}

export interface WorldModelSeedState {
  structured?: Record<string, unknown>;
  scratchpad?: string;
}

export interface NewWorldModelSessionRequest {
  task?: string | null;
  seed_state?: WorldModelSeedState | null;
}

export interface WorldModelStepRequest {
  action: WorldModelAction;
}
