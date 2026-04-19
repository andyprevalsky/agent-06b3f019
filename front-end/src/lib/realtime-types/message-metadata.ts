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
 */
export type BrowserActionType =
  | 'browser' // Init message (new browser session)
  | 'system' // Legacy init
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
