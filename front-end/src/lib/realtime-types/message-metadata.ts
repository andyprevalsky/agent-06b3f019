import type { BROWSER_EMITTED_ACTION_TYPES } from '../backendToolNames';
import type { RequestUserApprovalMetadata } from './tool-metadata';

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
 * Browser agent action types.
 *
 * DERIVED, never hand-maintained. `BROWSER_EMITTED_ACTION_TYPES` is the single
 * source of truth for what the browser agent actually emits, and this union is
 * projected from it so a producer-side action type cannot exist without the
 * type system knowing about it.
 *
 * This was previously a hand-written literal list, which silently drifted: the
 * runtime emitted `session_init`, `session_starting`, `payment_card_ready`, and
 * `write_lock_granted` while the union declared none of them. That drift is the
 * same class of defect this file's consumers exist to prevent — an untyped
 * action type read as something it is not (see the approval-resume regression
 * these types now guard).
 *
 * Historical action types kept for transcripts that predate the current
 * vocabulary are unioned in explicitly below.
 */
export type BrowserActionType =
  | 'phone'
  | (typeof BROWSER_EMITTED_ACTION_TYPES)[number]
  // Legacy literals retained for already-persisted messages. They are not in the
  // current emitted vocabulary, so they cannot be derived from it.
  | 'navigate'
  | 'type'
  | 'scroll'
  | 'hover'
  | 'session_started'
  | 'auth_assistance'
  | 'write_lock_rejected';

/**
 * Code agent action types.
 */
export type CodeActionType = 'code_complete' | 'code_error' | 'code_deployed';

/**
 * Claude Code agent action types.
 * See agents/tools/spawn_claude_code_agent.py:save_claude_code_message
 */
export type ClaudeCodeActionType =
  | 'claude_code_started' // Init message (new sandbox session)
  | 'task_started'
  | 'agent_observation' // Periodic status updates
  | 'system' // Verifier messages
  | 'task_complete'
  | 'session_cancelled'
  | 'error';

/**
 * WebSocket message types from Claude Code sandbox.
 * See e2b-templates/claude-code/ws-server.mjs
 */
export type ClaudeCodeWsMessage =
  | { type: 'buffer'; data: string } // Full history buffer on connect
  | { type: 'stdout'; data: string } // Live stdout chunk
  | { type: 'stderr'; data: string } // Live stderr chunk
  | { type: 'exit'; code: number } // Process exited
  | { type: 'error'; data: string }; // Server error

/** `metadata.inlineView` payload: `view@versionId` plus small JSON props. */
export interface InlineViewMessageMetadata {
  view: string;
  versionId: string;
  props?: unknown;
}

/**
 * Metadata attached to messages.
 * Different message types use different subsets of these fields.
 */
export interface MessageMetadata {
  userPause?: { reason: 'user'; recordedAt: string };
  auxiliary?: { coordinates?: { x: number; y: number } };
  requestUserApproval?: Partial<RequestUserApprovalMetadata['requestUserApproval']>;
  imageUrl?: string | null;
  subAgentIds?: string[];
  busId?: string;
  spawnGroupId?: string;
  forEachAggregate?: boolean;
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
  action_type?:
    | 'phone'
    | BrowserActionType
    | CodeActionType
    | ClaudeCodeActionType
    | 'credential_failure_classification';
  /** Task ID for browser/code agents */
  task_id?: string;
  /** Preview URL for deployed code */
  preview_url?: string;
  /**
   * Per-user inline trajectory view (rose_user_ui `inline/<view>/`), pinned to
   * the published version it was sent with; rendered in a sandboxed frame.
   */
  inlineView?: InlineViewMessageMetadata;
  /** Empty assistant file row emitted by a tool, displayed under its result. */
  artifactOnly?: boolean;
  /** Exact originating tool call identity, not a browser/code task id. */
  sourceToolCallId?: string;
  /** Allow additional fields for extensibility */
  [key: string]: unknown;
}

// -----------------------------------------------------------------------------
// Agent-to-agent rows (background agents + send_message_to_agent)
// -----------------------------------------------------------------------------

/**
 * USER row carrying a message from another agent in the same tree (not the
 * human). Written by the backend agent-messages endpoint.
 */
export interface AgentMessageMetadata {
  agentMessage?: true;
  /** Codex message type: MESSAGE | NEW_TASK. */
  messageType?: string;
  /** Sender agent id. */
  fromAgentId?: string;
  /** Sender agent goal (for the notice header). */
  fromGoal?: string;
  /** Sender's Codex-style tree path, e.g. `/root/outreach` (absent on older rows). */
  fromAgentPath?: string;
  /** Explore/browser task address when delivered to an in-activity agent. */
  recipientTaskId?: string;
}

/**
 * Row announcing that a sub-agent finished. Its text is a Codex body:
 * `Message Type: FINAL_ANSWER|FAILED\nTask name: …\nSender: …\nPayload:\n…`.
 */
export interface AgentNotificationMetadata {
  agentNotification?: true;
  toolName?: 'agent_notification';
  /** Codex message type: FINAL_ANSWER | FAILED (a killed agent failed). */
  messageType?: string;
  /** Address of the finished sub-agent (a tree path, e.g. `/root/a/b`). */
  fromAgentAddress?: string;
  fromAgentPath?: string;
  toAgentPath?: string;
  /** Terminal status (completed / failed). */
  status?: string;
}
