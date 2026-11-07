import { Prisma, type AgentStatus } from '@prisma/client';

export interface WorkflowResumeState {
  version: 1;
  kind: 'deployment' | 'validation';
  prior_status: AgentStatus;
  prior_status_message: string | null;
  progress: number;
  token_count: number;
  tokens_in: number;
  tokens_out: number;
  tree_tokens_in: number;
  tree_tokens_out: number;
  context_size: number;
  message_count: number;
  workflow_started_at: string;
  own_cost_cents: number;
  subtree_cost_cents: number;
  children_cost_cents: Record<string, number>;
  children_tokens_in: Record<string, number>;
  children_tokens_out: Record<string, number>;
  child_last_tokens: Record<string, { tokens_in: number; tokens_out: number; token_count: number }>;
  child_tool_counts: Record<string, number>;
  iteration_offset: number;
  max_iterations: number | null;
  context_gates: Record<string, boolean> | null;
  deployment_attempt?: string;
  runtime_state?: {
    deployment_validation?: boolean;
  };
}

export function workflowReplacementDeploymentAttempt(
  value: Prisma.JsonValue | null
): string | null {
  const attempt = savedResumeState(value).deployment_attempt;
  return typeof attempt === 'string' && attempt !== '' ? attempt : null;
}

export function savedResumeState(value: Prisma.JsonValue | null): WorkflowResumeState {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.kind !== 'deployment'
  ) {
    throw new Error('Workflow replacement claim is missing its durable resume state');
  }
  const childToolCounts =
    value.child_tool_counts !== null &&
    typeof value.child_tool_counts === 'object' &&
    !Array.isArray(value.child_tool_counts)
      ? value.child_tool_counts
      : {};
  return {
    ...value,
    child_tool_counts: childToolCounts,
  } as unknown as WorkflowResumeState;
}

/** Retain only boolean context gates from a stored JSON snapshot. */
export function booleanRecord(value: Prisma.JsonValue | null): Record<string, boolean> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, boolean] => {
    return typeof entry[1] === 'boolean';
  });
  return Object.fromEntries(entries);
}
