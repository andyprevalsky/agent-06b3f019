/**
 * Supabase Realtime Message Types
 *
 * This file defines the canonical types for all Supabase Realtime messages
 * received by the frontend. There are THREE channels the frontend subscribes to:
 *
 * 1. Agent Channel (`agent:{agentId}`) - Agent-specific events
 * 2. Bus Channel (`bus:{busId}`) - Sub-agent tree state updates
 * 3. User Channel (`user:{userId}`) - User attention requests (deprecated - uses polling)
 *
 * ## Message Flow
 *
 * All Supabase Realtime broadcast messages arrive with this wrapper structure:
 * ```
 * {
 *   payload: {
 *     record: { ...actual payload data... }
 *   }
 * }
 * ```
 *
 * The helpers in realtime.ts extract `payload.record` before calling handlers.
 */

import { Agent, OutputSchema, FilePointer } from './api';

// =============================================================================
// Raw Supabase Realtime Wrapper
// =============================================================================

/**
 * Raw wrapper structure from Supabase Realtime broadcast.
 * All broadcast messages arrive in this format.
 */
export interface RealtimeBroadcastWrapper<T> {
  payload: {
    record: T;
  };
}

// =============================================================================
// Agent Channel Events (agent:{agentId})
// =============================================================================

/**
 * Event names for the agent channel.
 */
export type AgentChannelEvent =
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'ASSISTANT_STREAM'
  | 'PLAN_STREAM'
  | 'TOOL_STREAM'
  | 'ATTENTION_STREAM'
  | 'AGENT_MODE_STARTED';

// -----------------------------------------------------------------------------
// INSERT Event - New message added to database
// -----------------------------------------------------------------------------

export type MessageRole = 'SYSTEM' | 'ASSISTANT' | 'USER' | 'TOOL';
export type ToolStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR';

/**
 * Metadata attached to messages.
 * Different message types use different subsets of these fields.
 */
export interface MessageMetadata {
  /** Links to a specific tool execution */
  toolCallId?: string;
  /** Name of the tool (e.g., "search_web", "set_plan") */
  toolName?: string;
  /** Current status of tool execution */
  toolStatus?: ToolStatus;
  /** Display title for UI rendering */
  title?: string;
  /** Routes message to sub-agent's MessageList (e.g., browser panel) */
  subAgentId?: string;
  /** Progress value (0.0-1.0 or 0-100) */
  progress?: number;
  /** Progress bar completion value */
  progressComplete?: number;
  /** Indicates an error occurred */
  error?: boolean;
  /** Marks as user attention message (send_message_to_user) */
  isUserAttentionMessage?: boolean;
  /** Browser agent current URL */
  browser_url?: string;
  /** Action type for browser/code agents */
  action_type?: BrowserActionType | CodeActionType;
  /** Task ID for browser/code agents */
  task_id?: string;
  /** Preview URL for deployed code */
  preview_url?: string;
  /** Allow additional fields for extensibility */
  [key: string]: unknown;
}

/**
 * Browser agent action types.
 */
export type BrowserActionType =
  | 'browser'       // Init message (new browser session)
  | 'system'        // Legacy init
  | 'navigate'
  | 'click'
  | 'type'
  | 'screenshot'
  | 'scroll'
  | 'hover'
  | 'wait'
  | 'error'
  | 'task_complete'
  | 'session_paused';

/**
 * Code agent action types.
 */
export type CodeActionType =
  | 'code_complete'
  | 'code_error'
  | 'code_deployed';

/**
 * Claude Code agent action types.
 * See agents/tools/spawn_claude_code_agent.py:save_claude_code_message
 */
export type ClaudeCodeActionType =
  | 'claude_code_started'  // Init message (new sandbox session)
  | 'task_started'
  | 'agent_observation'    // Periodic status updates
  | 'system'               // Verifier messages
  | 'task_complete'
  | 'session_cancelled'
  | 'error';

/**
 * WebSocket message types from Claude Code sandbox.
 * See e2b-templates/claude-code/ws-server.mjs
 */
export type ClaudeCodeWsMessage =
  | { type: 'buffer'; data: string }   // Full history buffer on connect
  | { type: 'stdout'; data: string }   // Live stdout chunk
  | { type: 'stderr'; data: string }   // Live stderr chunk
  | { type: 'exit'; code: number }     // Process exited
  | { type: 'error'; data: string };   // Server error

// =============================================================================
// Tool-Specific Metadata Types
// =============================================================================

/**
 * All tool names that can appear in metadata.toolName
 */
export type ToolName =
  | 'attempt_completion'
  | 'check_monitor_events'
  | 'deep_research'
  | 'enable_write_permissions'
  | 'enrich'
  | 'people_search'
  | 'find_all'
  | 'query_blueprints'
  | 'save_blueprint'
  | 'message_person'
  | 'monitor'
  | 'read_message_history_with_person'
  | 'request_user_approval'
  | 'request_user_signup'
  | 'search_user_network_for_people'
  | 'send_message_to_user'
  | 'send_message_to_user_execute_phase'
  | 'send_sms'
  | 'send_sms_as_user'
  | 'send_email'
  | 'set_plan'
  | 'spawn_browser_agent'
  | 'spawn_claude_code_agent'
  | 'spawn_sub_agent'
  | 'web_search'
  | 'search_x402_bazaar'
  | 'pay_for_x402_bazaar_service'
  | 'wait_seconds';

/**
 * Base metadata present on all TOOL messages.
 */
export interface BaseToolMetadata {
  toolCallId: string;
  toolName: ToolName;
  toolStatus: ToolStatus;
  title?: string;
}

/**
 * Metadata for spawn_browser_agent tool messages.
 * See agents/tools/spawn_browser_agent_v3.py:save_browser_action_message
 */
export interface SpawnBrowserAgentMetadata extends BaseToolMetadata {
  toolName: 'spawn_browser_agent';
  /** Unique task ID for this browser session */
  task_id: string;
  /** Current browser URL */
  browser_url?: string;
  /** Type of browser action performed */
  action_type?: BrowserActionType | string;
  /** Additional data from the action */
  auxiliary?: Record<string, unknown>;
  /** Routes to browser panel's MessageList (same as task_id for sub-actions) */
  subAgentId?: string;
  /** Indicates an error occurred */
  error?: boolean;
  /** Output schema for init message */
  output_schema?: OutputSchema;
}

/**
 * Metadata for spawn_claude_code_agent tool messages.
 * See agents/tools/spawn_claude_code_agent.py:save_claude_code_message
 */
export interface SpawnClaudeCodeAgentMetadata extends BaseToolMetadata {
  toolName: 'spawn_claude_code_agent';
  /** Unique task ID for this Claude Code session */
  task_id: string;
  /** WebSocket URL for terminal streaming */
  ws_url?: string;
  /** Type of action performed */
  action_type?: ClaudeCodeActionType | string;
  /** Routes to Claude Code panel's MessageList (same as task_id for sub-actions) */
  subAgentId?: string;
  /** Indicates an error occurred */
  error?: boolean;
  /** Output schema for init message */
  output_schema?: OutputSchema;
}

/**
 * Metadata for spawn_sub_agent tool messages.
 */
export interface SpawnSubAgentMetadata extends BaseToolMetadata {
  toolName: 'spawn_sub_agent';
  subAgentIds?: string[];
}

/**
 * A single task in the plan.
 * Contains the goal and tool to execute.
 */
export interface PlanTask {
  goal: string;
  tool_name: string;
}

/**
 * Plan artifact data structure.
 * Generated by planner LLM and attached to set_plan messages in metadata.data
 * See agents/tools/set_plan.py:298-306
 */
export interface PlanArtifactData {
  type: 'plan_artifact';
  title: string;
  content: string;
  /** Array of tasks - each task has goal and tool_name */
  tasks: PlanTask[];
  /** Map of task index to list of predecessor task indices */
  dependencies: Record<string, string[]>;
  /** 'all' = all tasks must succeed, 'any' = any one task can satisfy */
  join: 'all' | 'any';
  status: 'planning' | 'executing' | 'completed';
}

/**
 * Metadata for set_plan tool messages.
 * See agents/tools/set_plan.py
 */
export interface SetPlanMetadata extends BaseToolMetadata {
  toolName: 'set_plan';
  /** Plan artifact data - present when status is FINISHED */
  data?: PlanArtifactData;
}

/**
 * Metadata for send_message_to_user tool messages.
 */
export interface SendMessageToUserMetadata extends BaseToolMetadata {
  toolName: 'send_message_to_user' | 'send_message_to_user_execute_phase';
  isUserAttentionMessage: true;
  attentionMessage: string;
  sendMessageToUser: {
    isQuestion: boolean;
    attentionKind: 'question' | 'info';
    isWaitingForUser: boolean;
  };
}

/**
 * Metadata for request_user_signup tool messages.
 */
export interface RequestUserSignupMetadata extends BaseToolMetadata {
  toolName: 'request_user_signup';
  isUserAttentionMessage: true;
  attentionMessage: string;
  requestUserSignup: {
    isWaitingForUser: boolean;
    attentionKind: 'signup';
  };
}

/**
 * Metadata for request_user_approval tool messages.
 */
export interface RequestUserApprovalMetadata extends BaseToolMetadata {
  toolName: 'request_user_approval';
  requestUserApproval: {
    attentionRequestId: string;
  };
}

/**
 * Metadata for enable_write_permissions tool messages.
 */
export interface EnableWritePermissionsMetadata extends BaseToolMetadata {
  toolName: 'enable_write_permissions';
  writePermission?: boolean;
  permissionGranted?: boolean;
  reason?: string;
  actionDescription?: string;
}

/**
 * Metadata for read_message_history_with_person tool messages.
 */
export interface ReadMessageHistoryMetadata extends BaseToolMetadata {
  toolName: 'read_message_history_with_person';
  read_message_history_person?: {
    phone?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    person_id?: string;
    person_phone?: string;
    person_email?: string;
  };
}

/**
 * Metadata for tools with progress tracking (enrich, find_all, search_user_network_for_people).
 */
export interface ProgressToolMetadata extends BaseToolMetadata {
  toolName: 'enrich' | 'find_all' | 'search_user_network_for_people';
  progressComplete?: number;
}

/**
 * Metadata for simple tools without special fields.
 */
export interface SimpleToolMetadata extends BaseToolMetadata {
  toolName:
    | 'attempt_completion'
    | 'check_monitor_events'
    | 'deep_research'
    | 'query_blueprints'
    | 'save_blueprint'
    | 'message_person'
    | 'monitor'
    | 'send_sms'
    | 'send_sms_as_user'
    | 'send_email'
    | 'web_search'
    | 'search_x402_bazaar'
    | 'pay_for_x402_bazaar_service'
    | 'wait_seconds';
}

/**
 * Union of all tool-specific metadata types.
 */
export type ToolMessageMetadata =
  | SpawnBrowserAgentMetadata
  | SpawnClaudeCodeAgentMetadata
  | SpawnSubAgentMetadata
  | SetPlanMetadata
  | SendMessageToUserMetadata
  | RequestUserSignupMetadata
  | RequestUserApprovalMetadata
  | EnableWritePermissionsMetadata
  | ReadMessageHistoryMetadata
  | ProgressToolMetadata
  | SimpleToolMetadata;

// =============================================================================
// INSERT Event Payload
// =============================================================================

/**
 * INSERT event payload - New message from database.
 * Sent via Supabase Realtime when a message is inserted.
 */
export interface InsertMessagePayload {
  agentId: string;  // Used to filter messages for correct agent
  id: string;
  timestamp: string;  // ISO 8601 format
  text: string;
  role: MessageRole;
  metadata?: MessageMetadata | null;
  file_pointer?: FilePointer | null;  // File attachment (OAI-style: one file per message)
}

/**
 * Typed TOOL message payload with discriminated union on toolName.
 */
export interface ToolMessagePayload<T extends ToolMessageMetadata = ToolMessageMetadata> {
  id: string;
  timestamp: string;
  text: string;
  role: 'TOOL';
  metadata: T;
}

/**
 * Type guard to check if a message is a TOOL message.
 * NOTE: Only call on validated InsertMessagePayload from extractInsertPayload().
 * TOOL messages are guaranteed to have metadata with toolName/toolCallId/toolStatus.
 */
export function isToolMessage(msg: InsertMessagePayload): msg is ToolMessagePayload {
  if (msg.role !== 'TOOL') return false;
  if (!msg.metadata || typeof msg.metadata.toolName !== 'string') {
    console.error('❌ [Realtime] isToolMessage called on invalid TOOL message (missing metadata.toolName)', msg);
    return false;
  }
  return true;
}

/**
 * Type guard for spawn_browser_agent messages.
 */
export function isSpawnBrowserAgentMessage(
  msg: InsertMessagePayload
): msg is ToolMessagePayload<SpawnBrowserAgentMetadata> {
  return msg.role === 'TOOL' && msg.metadata !== null && msg.metadata !== undefined && msg.metadata.toolName === 'spawn_browser_agent';
}

/**
 * Type guard for spawn_claude_code_agent messages.
 */
export function isSpawnClaudeCodeAgentMessage(
  msg: InsertMessagePayload
): msg is ToolMessagePayload<SpawnClaudeCodeAgentMetadata> {
  return msg.role === 'TOOL' && msg.metadata !== null && msg.metadata !== undefined && msg.metadata.toolName === 'spawn_claude_code_agent';
}

/**
 * Type guard for set_plan messages.
 */
export function isSetPlanMessage(
  msg: InsertMessagePayload
): msg is ToolMessagePayload<SetPlanMetadata> {
  return msg.role === 'TOOL' && msg.metadata !== null && msg.metadata !== undefined && msg.metadata.toolName === 'set_plan';
}

/**
 * Type guard for send_message_to_user messages.
 */
export function isSendMessageToUserMessage(
  msg: InsertMessagePayload
): msg is ToolMessagePayload<SendMessageToUserMetadata> {
  if (msg.role !== 'TOOL' || msg.metadata === null || msg.metadata === undefined) return false;
  return msg.metadata.toolName === 'send_message_to_user' || msg.metadata.toolName === 'send_message_to_user_execute_phase';
}

/**
 * Type guard for request_user_signup messages.
 */
export function isRequestUserSignupMessage(
  msg: InsertMessagePayload
): msg is ToolMessagePayload<RequestUserSignupMetadata> {
  return msg.role === 'TOOL' && msg.metadata !== null && msg.metadata !== undefined && msg.metadata.toolName === 'request_user_signup';
}

/**
 * Type guard for ASSISTANT messages with file attachments.
 * These are output files from tools like Claude Code.
 */
export function isAssistantFileMessage(
  msg: InsertMessagePayload
): msg is InsertMessagePayload & { file_pointer: FilePointer } {
  return msg.role === 'ASSISTANT' && msg.file_pointer != null;
}

// -----------------------------------------------------------------------------
// UPDATE Event - Agent state update
// -----------------------------------------------------------------------------

/**
 * UPDATE event payload - Agent state changed.
 * Sent when agent status, progress, or other fields change.
 *
 * Note: Field names use camelCase (from Prisma) not snake_case.
 */
export interface UpdateAgentPayload {
  progress?: number;
  status?: Agent['status'];
  statusMessage?: string | null;
  model?: string;
  tokenCount?: number;
  tokensIn?: number;
  tokensOut?: number;
  contextSize?: number;
  messageCount?: number;
  treeCostCents?: number;  // Real-time tree cost updates (for price limit feature)
  updatedAt?: string;
  temporalWorkflowId?: string | null;
}

// -----------------------------------------------------------------------------
// DELETE Event - Message deleted
// -----------------------------------------------------------------------------

/**
 * DELETE event payload - Message removed from database.
 */
export interface DeleteMessagePayload {
  id: string;
}

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
  /** Sequence number for ordering and deduplication */
  sequence: number;
  /** Routes to sub-agent's MessageList (e.g., browser panel) */
  subAgentId?: string;
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

// =============================================================================
// Bus Channel Events (bus:{busId})
// =============================================================================

/**
 * Event names for the bus channel.
 */
export type BusChannelEvent = 'AGENT_STATE_CHANGED';

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
  /** List of currently active tool names */
  toolsInUse: string[];
  /** Total message count */
  messageCount: number;
  /** Optional output schema for structured responses */
  outputSchema?: OutputSchema;
  /** Structured output if available */
  structuredOutput?: Record<string, unknown>;
  /** Failure context for failed agents */
  failureContext?: FailureContext;
}

// =============================================================================
// User Channel Events (user:{userId}) - DEPRECATED
// =============================================================================

/**
 * Event names for the user channel.
 * NOTE: Backend doesn't actively broadcast to this channel.
 * AttentionInbox uses polling instead (10s interval).
 */
export type UserChannelEvent = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Attention request structure.
 * Used by AttentionInbox polling, not realtime broadcast.
 */
export interface AttentionRequestPayload {
  id: string;
  agentId: string;
  workflowId: string;
  question: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
  userResponse?: string;
  createdAt: string;
  updatedAt: string;
  answered: boolean;
}

// =============================================================================
// Handler Types
// =============================================================================

/**
 * Typed handlers for agent channel events.
 */
export interface AgentChannelHandlers {
  onInsert?: (payload: InsertMessagePayload) => void;
  onUpdate?: (payload: UpdateAgentPayload) => void;
  onDelete?: (payload: DeleteMessagePayload) => void;
  onAssistantStream?: (payload: AssistantStreamPayload) => void;
  onPlanStream?: (payload: PlanStreamPayload) => void;
  onToolStream?: (payload: ToolStreamPayload) => void;
  onAttentionStream?: (payload: AttentionStreamPayload) => void;
  onAgentModeStarted?: (payload: AgentModeStartedPayload) => void;
}

/**
 * Typed handlers for bus channel events.
 */
export interface BusChannelHandlers {
  onAgentStateChanged?: (payload: AgentStateChangedPayload) => void;
}

/**
 * Typed handlers for user channel events (deprecated - uses polling).
 */
export interface UserChannelHandlers {
  onInsert?: (payload: AttentionRequestPayload) => void;
  onUpdate?: (payload: AttentionRequestPayload) => void;
  onDelete?: (payload: { id: string }) => void;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for INSERT message payloads.
 */
export function isInsertMessagePayload(payload: unknown): payload is InsertMessagePayload {
  const p = payload as InsertMessagePayload;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.agentId === 'string' &&
    typeof p.id === 'string' &&
    typeof p.timestamp === 'string' &&
    typeof p.text === 'string' &&
    typeof p.role === 'string' &&
    ['SYSTEM', 'ASSISTANT', 'USER', 'TOOL'].includes(p.role)
  );
}

/**
 * Type guard for ASSISTANT_STREAM payloads.
 */
export function isAssistantStreamPayload(payload: unknown): payload is AssistantStreamPayload {
  const p = payload as AssistantStreamPayload;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.agentId === 'string' &&
    typeof p.stream_id === 'string' &&
    typeof p.delta === 'string' &&
    typeof p.done === 'boolean' &&
    typeof p.sequence === 'number'
  );
}

/**
 * Type guard for AGENT_STATE_CHANGED payloads.
 */
export function isAgentStateChangedPayload(payload: unknown): payload is AgentStateChangedPayload {
  const p = payload as AgentStateChangedPayload;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.agentId === 'string' &&
    typeof p.goal === 'string' &&
    typeof p.status === 'string' &&
    typeof p.progress === 'number' &&
    Array.isArray(p.toolsInUse)
  );
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate InsertMessagePayload structure.
 * Returns error message if invalid, null if valid.
 */
function validateInsertMessagePayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string') return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.id !== 'string') return `Missing or invalid 'id' (got ${typeof p.id})`;
  if (typeof p.timestamp !== 'string') return `Missing or invalid 'timestamp' (got ${typeof p.timestamp})`;
  if (typeof p.text !== 'string') return `Missing or invalid 'text' (got ${typeof p.text})`;
  if (typeof p.role !== 'string') return `Missing or invalid 'role' (got ${typeof p.role})`;
  if (!['SYSTEM', 'ASSISTANT', 'USER', 'TOOL'].includes(p.role as string)) {
    return `Invalid role '${p.role}'. Must be SYSTEM, ASSISTANT, USER, or TOOL`;
  }
  // Validate TOOL message metadata
  if (p.role === 'TOOL') {
    if (p.metadata === undefined || p.metadata === null) {
      return 'TOOL message missing metadata';
    }
    const meta = p.metadata as Record<string, unknown>;
    if (typeof meta.toolCallId !== 'string') return `TOOL metadata missing 'toolCallId' (got ${typeof meta.toolCallId})`;
    if (typeof meta.toolName !== 'string') return `TOOL metadata missing 'toolName' (got ${typeof meta.toolName})`;
    if (typeof meta.toolStatus !== 'string') return `TOOL metadata missing 'toolStatus' (got ${typeof meta.toolStatus})`;
    if (!['IN_PROGRESS', 'FINISHED', 'ERROR'].includes(meta.toolStatus as string)) {
      return `Invalid toolStatus '${meta.toolStatus}'. Must be IN_PROGRESS, FINISHED, or ERROR`;
    }
  }
  return null;
}

/**
 * Validate UpdateAgentPayload structure.
 * Returns error message if invalid, null if valid.
 */
function validateUpdateAgentPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  // UPDATE payloads are partial - all fields optional, but if present must be correct type
  const p = payload as Record<string, unknown>;
  if (p.progress !== undefined && typeof p.progress !== 'number') {
    return `Invalid 'progress' type (got ${typeof p.progress})`;
  }
  if (p.status !== undefined && typeof p.status !== 'string') {
    return `Invalid 'status' type (got ${typeof p.status})`;
  }
  if (p.tokenCount !== undefined && typeof p.tokenCount !== 'number') {
    return `Invalid 'tokenCount' type (got ${typeof p.tokenCount})`;
  }
  return null;
}

/**
 * Validate AssistantStreamPayload structure.
 * Returns error message if invalid, null if valid.
 */
function validateAssistantStreamPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string') return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.stream_id !== 'string') return `Missing or invalid 'stream_id' (got ${typeof p.stream_id})`;
  if (typeof p.delta !== 'string') return `Missing or invalid 'delta' (got ${typeof p.delta})`;
  if (typeof p.done !== 'boolean') return `Missing or invalid 'done' (got ${typeof p.done})`;
  if (typeof p.sequence !== 'number') return `Missing or invalid 'sequence' (got ${typeof p.sequence})`;
  return null;
}

/**
 * Validate PlanStreamPayload structure.
 * Returns error message if invalid, null if valid.
 */
function validatePlanStreamPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string') return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.stream_id !== 'string') return `Missing or invalid 'stream_id' (got ${typeof p.stream_id})`;
  if (typeof p.tool_call_id !== 'string') return `Missing or invalid 'tool_call_id' (got ${typeof p.tool_call_id})`;
  if (typeof p.title !== 'string') return `Missing or invalid 'title' (got ${typeof p.title})`;
  return null;
}

/**
 * Validate ToolStreamPayload structure.
 * Returns error message if invalid, null if valid.
 */
function validateToolStreamPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string') return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.stream_id !== 'string') return `Missing or invalid 'stream_id' (got ${typeof p.stream_id})`;
  if (typeof p.tool_call_id !== 'string') return `Missing or invalid 'tool_call_id' (got ${typeof p.tool_call_id})`;
  if (typeof p.tool_name !== 'string') return `Missing or invalid 'tool_name' (got ${typeof p.tool_name})`;
  if (typeof p.title !== 'string') return `Missing or invalid 'title' (got ${typeof p.title})`;
  return null;
}

/**
 * Validate AttentionStreamPayload structure.
 * Returns error message if invalid, null if valid.
 */
function validateAttentionStreamPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string') return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.stream_id !== 'string') return `Missing or invalid 'stream_id' (got ${typeof p.stream_id})`;
  if (typeof p.tool_call_id !== 'string') return `Missing or invalid 'tool_call_id' (got ${typeof p.tool_call_id})`;
  if (typeof p.message !== 'string') return `Missing or invalid 'message' (got ${typeof p.message})`;
  if (typeof p.is_question !== 'boolean') return `Missing or invalid 'is_question' (got ${typeof p.is_question})`;
  if (typeof p.done !== 'boolean') return `Missing or invalid 'done' (got ${typeof p.done})`;
  if (typeof p.sequence !== 'number') return `Missing or invalid 'sequence' (got ${typeof p.sequence})`;
  return null;
}

/**
 * Validate AgentStateChangedPayload structure.
 * Returns error message if invalid, null if valid.
 */
function validateAgentStateChangedPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string') return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.goal !== 'string') return `Missing or invalid 'goal' (got ${typeof p.goal})`;
  if (typeof p.status !== 'string') return `Missing or invalid 'status' (got ${typeof p.status})`;
  if (typeof p.progress !== 'number') return `Missing or invalid 'progress' (got ${typeof p.progress})`;
  if (!Array.isArray(p.toolsInUse)) return `Missing or invalid 'toolsInUse' (got ${typeof p.toolsInUse})`;
  if (typeof p.messageCount !== 'number') return `Missing or invalid 'messageCount' (got ${typeof p.messageCount})`;
  return null;
}

/**
 * Validate AgentModeStartedPayload structure.
 * Returns error message if invalid, null if valid.
 */
function validateAgentModeStartedPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string') return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  return null;
}

// =============================================================================
// Strict Extraction Functions (with validation + error logging)
// =============================================================================

/**
 * Extract and validate the record from a Supabase Realtime broadcast wrapper.
 * Logs error and returns null if the payload structure is invalid.
 */
function extractAndValidate<T>(
  wrapper: unknown,
  eventType: string,
  validator: (payload: unknown) => string | null
): T | null {
  // First extract from wrapper
  const w = wrapper as RealtimeBroadcastWrapper<T>;
  if (
    typeof w !== 'object' ||
    w === null ||
    typeof w.payload !== 'object' ||
    w.payload === null ||
    !('record' in w.payload)
  ) {
    console.error(`❌ [Realtime] Unknown Message Type for ${eventType}: Invalid wrapper structure`, wrapper);
    return null;
  }

  const record = w.payload.record;
  const error = validator(record);
  if (error) {
    console.error(`❌ [Realtime] Unknown Message Type for ${eventType}: ${error}`, record);
    return null;
  }

  return record;
}

/**
 * Extract and validate INSERT message payload.
 * Transforms DB column names to API format (filePointer -> file_pointer).
 */
export function extractInsertPayload(wrapper: unknown): InsertMessagePayload | null {
  const record = extractAndValidate<InsertMessagePayload>(wrapper, 'INSERT', validateInsertMessagePayload);
  if (!record) return null;

  // Transform DB column name (camelCase) to API format (snake_case)
  const dbRecord = record as unknown as Record<string, unknown>;
  if (dbRecord.filePointer !== undefined) {
    record.file_pointer = dbRecord.filePointer as FilePointer | null;
  }

  return record;
}

/**
 * Extract and validate UPDATE agent payload.
 */
export function extractUpdatePayload(wrapper: unknown): UpdateAgentPayload | null {
  return extractAndValidate<UpdateAgentPayload>(wrapper, 'UPDATE', validateUpdateAgentPayload);
}

/**
 * Extract and validate DELETE payload.
 */
export function extractDeletePayload(wrapper: unknown): DeleteMessagePayload | null {
  return extractAndValidate<DeleteMessagePayload>(wrapper, 'DELETE', (p) => {
    if (typeof p !== 'object' || p === null) return 'Payload is not an object';
    if (typeof (p as Record<string, unknown>).id !== 'string') return 'Missing or invalid id';
    return null;
  });
}

/**
 * Extract and validate ASSISTANT_STREAM payload.
 */
export function extractAssistantStreamPayload(wrapper: unknown): AssistantStreamPayload | null {
  return extractAndValidate<AssistantStreamPayload>(wrapper, 'ASSISTANT_STREAM', validateAssistantStreamPayload);
}

/**
 * Extract and validate PLAN_STREAM payload.
 */
export function extractPlanStreamPayload(wrapper: unknown): PlanStreamPayload | null {
  return extractAndValidate<PlanStreamPayload>(wrapper, 'PLAN_STREAM', validatePlanStreamPayload);
}

/**
 * Extract and validate TOOL_STREAM payload.
 */
export function extractToolStreamPayload(wrapper: unknown): ToolStreamPayload | null {
  return extractAndValidate<ToolStreamPayload>(wrapper, 'TOOL_STREAM', validateToolStreamPayload);
}

/**
 * Extract and validate ATTENTION_STREAM payload.
 */
export function extractAttentionStreamPayload(wrapper: unknown): AttentionStreamPayload | null {
  return extractAndValidate<AttentionStreamPayload>(wrapper, 'ATTENTION_STREAM', validateAttentionStreamPayload);
}

/**
 * Extract and validate AGENT_STATE_CHANGED payload.
 */
export function extractAgentStateChangedPayload(wrapper: unknown): AgentStateChangedPayload | null {
  return extractAndValidate<AgentStateChangedPayload>(wrapper, 'AGENT_STATE_CHANGED', validateAgentStateChangedPayload);
}

/**
 * Extract and validate AGENT_MODE_STARTED payload.
 */
export function extractAgentModeStartedPayload(wrapper: unknown): AgentModeStartedPayload | null {
  return extractAndValidate<AgentModeStartedPayload>(wrapper, 'AGENT_MODE_STARTED', validateAgentModeStartedPayload);
}

// =============================================================================
// Legacy Utility (for backwards compatibility - prefer typed extractors above)
// =============================================================================

/**
 * @deprecated Use typed extractors (extractInsertPayload, extractUpdatePayload, etc.) instead.
 * Extract the record from a Supabase Realtime broadcast wrapper without validation.
 */
export function extractRecord<T>(wrapper: unknown): T | null {
  const w = wrapper as RealtimeBroadcastWrapper<T>;
  if (
    typeof w === 'object' &&
    w !== null &&
    typeof w.payload === 'object' &&
    w.payload !== null &&
    'record' in w.payload
  ) {
    return w.payload.record;
  }
  console.error('❌ [Realtime] Unknown Message Type: Invalid wrapper structure', wrapper);
  return null;
}
