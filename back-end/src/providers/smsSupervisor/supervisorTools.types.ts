/** Shared SMS-supervisor tool types and helpers (leaf module: imports nothing local). */

export interface ReplyToAgentArgs {
  agent_id_or_prefix: string;
  message: string;
  attention_request_id?: string;
  reject?: boolean;
}

export interface KillAgentArgs {
  agent_id_or_prefix: string;
}

export interface IncreaseBudgetArgs {
  agent_id_or_prefix: string;
  amount_dollars: number;
}

export interface StartNewAgentArgs {
  goal: string;
  budget_dollars?: number;
}

export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  success: boolean;
  result: string;
  error?: string;
}

export interface ToolInvocationContext {
  currentUserMessage: string;
  visibleSessionHistory: string[];
  pendingAttentionRequestIds: string[];
}

export type PendingOp =
  | { kind: 'reply_to_agent'; args: ReplyToAgentArgs; agentId: string }
  | { kind: 'kill_agent'; args: KillAgentArgs; agentId: string }
  | { kind: 'increase_budget'; args: IncreaseBudgetArgs; agentId: string }
  | { kind: 'start_new_agent'; args: StartNewAgentArgs; provisionalId: string };

export function formatTaskLabel(goal: string, maxLength = 80): string {
  const normalized = goal.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.substring(0, maxLength - 3)}...`
    : normalized;
}
