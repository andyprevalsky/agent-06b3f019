import type { Agent, OutputSchema } from '../api';

// =============================================================================
// Bus Channel Events (bus:{busId})
// =============================================================================

/**
 * Event names for the bus channel.
 */
export type BusChannelEvent = 'AGENT_STATE_CHANGED' | 'UPDATE';

// -----------------------------------------------------------------------------
// AGENT_STATE_CHANGED Event - Sub-agent tree update
// -----------------------------------------------------------------------------

/**
 * Trajectory step in failure context.
 * Records each tool call with success/failure info.
 */
export interface TrajectoryStep {
  tool_name: string;
  success: boolean;
  error_message?: string | null;
}

/**
 * Failure context for failed agents.
 * Contains information to help parent agents learn from failures.
 */
export interface FailureContext {
  /** Trajectory of tool calls */
  trajectory: TrajectoryStep[];
  /** Last reasoning/thought from the agent */
  last_reasoning?: string | null;
  /** Plan tasks the agent was working on */
  last_plan?: string[] | null;
  /** Progress estimate (percentage or step count) */
  progress_estimate: string;
  /** Why the verifier thought the task wasn't complete */
  verifier_reasoning?: string;
  /** Partial structured data extracted before failure */
  partial_structured_response?: Record<string, unknown> | null;
  /** Number of tool calls made */
  steps_taken: number;
}

/**
 * AGENT_STATE_CHANGED payload - Sub-agent state update.
 *
 * Broadcast by agents in a sub-agent tree to notify the frontend
 * of state changes. Used for real-time tree rendering.
 */
export interface AgentStateChangedPayload {
  temporalWorkflowId?: string;
  /** The agent broadcasting this update */
  agentId: string;
  /** Parent agent ID (for tree structure) */
  parentAgentId: string | null;
  /** Agent's goal */
  goal: string;
  /** Current status */
  status: Agent['status'];
  /** Progress value (0.0-1.0) */
  progress: number;
  progressEstimate?: import('../api/types').ProgressEstimate | null;
  taskId?: string;
  updatedAt?: string;
  /** List of currently active tool names */
  toolsInUse: string[];
  /** Total message count */
  messageCount: number;
  /** Subtree cost in cents (this agent + all children) */
  costCents?: number;
  /** Optional output schema for structured responses */
  outputSchema?: OutputSchema;
  /** Structured output if available */
  structuredOutput?: Record<string, unknown>;
  /** Failure context for failed agents */
  failureContext?: FailureContext;
}
