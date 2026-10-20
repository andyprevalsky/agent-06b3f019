import type { ToolStatus } from './message-metadata';

// -----------------------------------------------------------------------------
// ASSISTANT_STREAM Event - LLM streaming chunks
// -----------------------------------------------------------------------------

/**
 * ASSISTANT_STREAM payload - Streaming text from LLM.
 *
 * The worker sends DELTAS (incremental text), not accumulated text.
 * Frontend accumulates deltas into streamingBubbles state.
 */
export interface AssistantStreamPayload {
  /** Agent ID for filtering messages to correct agent */
  agentId: string;
  /** Unique ID for this streaming session */
  stream_id: string;
  /** New text chunk (delta, NOT accumulated) */
  delta: string;
  /** True when streaming is complete */
  done: boolean;
  /** Clear this purely-ephemeral stream as soon as its done event arrives */
  clear_on_done?: boolean;
  /** Sequence number for ordering and deduplication */
  sequence: number;
  /** Routes to sub-agent's MessageList (e.g., browser panel) */
  subAgentId?: string;
  /** Epoch ms when the LLM request started, before first token */
  llm_started_at_ms?: number;
  /** True when the streaming model is Claude (Anthropic) - used for thinking animation theming */
  is_claude?: boolean;
  /** True when the streaming model is direct GPT/Codex - used for thinking animation theming */
  is_gpt?: boolean;
  /** Total streamed bytes, including hidden provider chunks not reflected in `delta` */
  char_count?: number;
}

// -----------------------------------------------------------------------------
// PLAN_STREAM Event - Plan generation indicator
// -----------------------------------------------------------------------------

/**
 * PLAN_STREAM payload - Shows PlanChip with shimmer during planning.
 *
 * This is ephemeral (not persisted to DB). The final plan arrives via
 * INSERT with toolName="set_plan" and toolStatus="FINISHED".
 */
export interface PlanStreamPayload {
  /** Agent ID for filtering messages to correct agent */
  agentId: string;
  /** Unique ID for this streaming session */
  stream_id: string;
  /** Links to the eventual set_plan tool execution */
  tool_call_id: string;
  /** Display title (e.g., "Creating Plan") */
  title: string;
  /** Current character count of plan content being generated */
  char_count?: number;
  /** Epoch ms when the planner LLM request started, before first token */
  llm_started_at_ms?: number;
}

// -----------------------------------------------------------------------------
// TOOL_STREAM Event - Early tool detection indicator
// -----------------------------------------------------------------------------

/**
 * TOOL_STREAM payload - Shows tool indicator during LLM streaming.
 *
 * This is ephemeral (not persisted to DB). Broadcast when LLM starts
 * generating a tool call, before parameters are fully parsed.
 * Cleared when the real TOOL INSERT arrives with matching toolCallId.
 */
export interface ToolStreamPayload {
  /** Agent ID for filtering messages to correct agent */
  agentId: string;
  /** Unique ID for this streaming session */
  stream_id: string;
  /** Links to the eventual tool execution */
  tool_call_id: string;
  /** Name of the tool being called */
  tool_name: string;
  /** Display title (e.g., "Starting web_search...") */
  title: string;
  /** Current status when broadcaster includes tool execution state */
  status?: ToolStatus;
  /** Current raw character count streamed while forming the tool call */
  char_count?: number;
  /** Epoch ms when the LLM request started, before first token */
  llm_started_at_ms?: number;
  /** Routes ephemeral browser/sub-agent tools to their dedicated MessageList */
  subAgentId?: string;
  /** True when the streaming model is Claude (Anthropic) - used for thinking animation theming */
  is_claude?: boolean;
  /** True when the streaming model is direct GPT/Codex - used for thinking animation theming */
  is_gpt?: boolean;
}

// -----------------------------------------------------------------------------
// ATTENTION_STREAM Event - send_message_to_user streaming
// -----------------------------------------------------------------------------

/**
 * ATTENTION_STREAM payload - Streams send_message_to_user content.
 *
 * Unlike ASSISTANT_STREAM, this sends accumulated message (not delta)
 * because attention messages need to be displayed as a complete unit.
 */
export interface AttentionStreamPayload {
  /** Agent ID for filtering messages to correct agent */
  agentId: string;
  /** Unique ID for this streaming session */
  stream_id: string;
  /** Links to the send_message_to_user tool execution */
  tool_call_id: string;
  /** Current message content (accumulated, NOT delta) */
  message: string;
  /** True if this is a blocking question requiring response */
  is_question: boolean;
  /** True when streaming is complete */
  done: boolean;
  /** Sequence number for ordering */
  sequence: number;
}

// -----------------------------------------------------------------------------
// AGENT_MODE_STARTED Event - Chat escalated to agent mode
// -----------------------------------------------------------------------------

/**
 * AGENT_MODE_STARTED payload - Chat mode escalated to full agent.
 *
 * Sent when the backend creates a Temporal workflow for a chat-mode agent.
 * Frontend should set isChatMode=false when received.
 */
export interface AgentModeStartedPayload {
  agentId: string;
}

// -----------------------------------------------------------------------------
// USER_UI_ACTIVE_CHANGED Event - a code agent published + activated a Rose UI
// -----------------------------------------------------------------------------

/**
 * Sent on the publishing code agent's agent:<id> channel AND its root's
 * (backend broadcastUserUiActiveChanged) after `rose-ui publish` activates a
 * version. The open tab refetches GET /api/user-ui/active unless `versionId`
 * is already applied.
 */
export interface UserUiActiveChangedPayload {
  versionId: string;
  /** The publishing (code) agent. */
  agentId: string;
}

// -----------------------------------------------------------------------------
// BROWSER_SESSION Event - a browser task's provider-session binding changed
// -----------------------------------------------------------------------------

/**
 * BROWSER_SESSION payload - the provider session a browser task is bound to.
 *
 * Sent when the backend rebinds a task's BrowserSession row (challenge
 * recovery, resume, rotation, reclaim) before releasing the old session, and
 * when the row is paused or closed. The live-view GET returns the same shape;
 * consumers keep the newest `asOf` per task.
 */
export interface BrowserSessionBindingPayload {
  agentId?: string;
  taskId: string;
  sessionId: string;
  debugUrl: string | null;
  status: string;
  /** false: closed or ended by the provider; null: provider health unknown. */
  live: boolean | null;
  /** Server time in ms. */
  asOf: number;
}
