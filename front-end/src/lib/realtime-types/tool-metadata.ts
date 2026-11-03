import type { FilePointer, OutputSchema } from '../api';
import type { BrowserActionType, ClaudeCodeActionType, ToolStatus } from './message-metadata';

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
  | 'spawn_agent'
  | 'spawn_browser_agent'
  | 'spawn_claude_code_agent'
  | 'spawn_general_purpose_agent'
  | 'spawn_general_purpose_agent_for_each'
  | 'spawn_sub_agent'
  | 'web_search'
  | 'search_x402_bazaar'
  | 'pay_for_x402_bazaar_service'
  | 'wait_for'
  | 'wait_seconds'
  | 'add_memory'
  | 'read_memories';

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
  /** Uploaded replay artifact on the `recording` message, resolved by the FE to a
   * signed URL so the recording is viewable after the run (the live debugUrl is
   * gone). Two shapes by `mime_type`: a `video/*` pointer is the `rotate_ip`
   * per-session segments stitched server-side into ONE continuous MP4 (FE plays a
   * single <video>); a `text/html` pointer is the legacy self-contained screenshot
   * player (FE iframes it). Preferred over `recording_view_url(s)`. */
  recording_file_pointer?: FilePointer | null;
  /** Kernel-native session replay: a hosted, self-contained video player URL
   * (JWT baked in, iframe-embeddable). When present the front-end iframes it
   * directly, skipping the Supabase FilePointer fetch. Preferred over
   * `recording_file_pointer` when both exist. */
  recording_view_url?: string | null;
  /** Ordered Kernel replay segments, one per browser session in the run. The
   * `rotate_ip` tool evicts the current session and stands up a new one on a
   * different exit IP, so a single replay would only ever show the first IP. Each
   * entry is a hosted, iframe-embeddable player URL; segment 0 is the baseline and
   * each subsequent entry is a post-rotation session (a new IP). Fallback only:
   * emitted when the segments could not be stitched into one MP4 (no ffmpeg /
   * download failure); the FE then plays the segment URLs back-to-back as one
   * continuous player. `recording_view_url` points at segment 0 for back-compat. */
  recording_view_urls?: string[] | null;
  /** Browser provider and proxy metadata captured for this browser session. */
  browser_session_metadata?: {
    provider?: string;
    proxy_source?: string;
    proxy_location?: {
      city?: string;
      state?: string;
      country?: string;
    };
  };
  /** Live auth handoff payload while the browser agent waits for user login. */
  requestUserAuthentication?: {
    requestId: string;
    authRealm?: string;
    steelSessionId?: string;
    taskId?: string;
    handoffMode?: string;
    browserUrl?: string;
    liveViewUrl?: string;
  };
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
  /** GitHub repo URL for this session */
  github_repo_url?: string;
  /** Runtime provider selected from the workflow compute token */
  code_provider?: 'claude' | 'codex';
}

export type GeneralPurposeAgentToolName =
  'spawn_general_purpose_agent' | 'spawn_general_purpose_agent_for_each' | 'spawn_sub_agent';

/**
 * Metadata for general-purpose agent spawn tool messages.
 * `spawn_sub_agent` remains accepted for internal/back-compat plumbing.
 */
export interface SpawnSubAgentMetadata extends BaseToolMetadata {
  toolName: GeneralPurposeAgentToolName;
  subAgentIds?: string[];
  subAgentId?: string;
  busId?: string;
  spawnGroupId?: string;
}

/**
 * Metadata for wait_for tool messages.
 * See agents/tools/wait_for.py
 */
export interface WaitForMetadata extends BaseToolMetadata {
  toolName: 'wait_for';
  /** 'condition' or 'timestamp' */
  waitForMode?: 'condition' | 'timestamp';
  /** Natural-language condition being polled (condition mode) */
  condition?: string;
  /** Concise phrase used in the collapsed "Waiting for ..." title */
  description?: string;
  /** ISO 8601 target timestamp (timestamp mode) */
  untilTimestamp?: string;
  /** Seconds between checks (condition mode) */
  checkIntervalSeconds?: number;
  /** Current check number (condition mode, during polling) */
  checkNum?: number;
  /** Maximum number of checks (condition mode) */
  maxChecks?: number;
  /** Duration to wait in seconds (timestamp mode) */
  durationSeconds?: number;
  /** Whether the condition was met (condition mode) */
  conditionMet?: boolean;
  /** Links to explore agent task for FE grouping (condition mode) */
  exploreTaskId?: string;
  /** Structured data from FINISHED events */
  data?: {
    condition_met?: boolean;
    checks_completed?: number;
    evidence?: string;
  };
}

/**
 * Metadata for spawn_agent tool messages (unified agent spawning).
 * See agents/tools/spawn_agent.py:save_explore_message
 */
export interface SpawnAgentMetadata extends BaseToolMetadata {
  toolName: 'spawn_agent';
  /** Agent type: explore, browser, code, general_purpose */
  agentType?: 'explore' | 'browser' | 'code' | 'general_purpose';
  /** Unique task ID for this agent session */
  taskId?: string;
  /** Routes intermediate messages to sub-panel */
  subAgentId?: string;
  /** Indicates an error occurred */
  error?: boolean;
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

export interface RequestPaymentCardPayload {
  fingerprint?: string;
  merchant?: string;
  currency?: string;
  lineItems?: Array<{
    name?: string;
    imageUrl?: string | null;
    productUrl?: string;
    rating?: string;
    reviewCount?: string;
    unitPriceCents?: number;
    quantity?: number;
    lineTotalCents?: number;
  }>;
  fees?: Array<{ label?: string; amountCents?: number }>;
  subtotalCents?: number;
  totalCents?: number;
  paymentMethodLast4?: string;
  autopayLimitCents?: number;
}

/**
 * Metadata for request_user_approval tool messages.
 */
export interface RequestUserApprovalMetadata extends BaseToolMetadata {
  toolName: 'request_user_approval';
  requestUserApproval: {
    attentionRequestId: string;
    toolApproval?: boolean;
    writePermission?: boolean;
    url?: string;
    requestPaymentCard?: RequestPaymentCardPayload;
    /** Who asked (code agents via agent-tools); parsed by the code-agent contract. */
    requestingAgent?: unknown;
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
    | 'wait_seconds'
    | 'add_memory'
    | 'read_memories';
}

/**
 * Union of all tool-specific metadata types.
 */
export type ToolMessageMetadata =
  | SpawnAgentMetadata
  | SpawnBrowserAgentMetadata
  | SpawnClaudeCodeAgentMetadata
  | SpawnAgentMetadata
  | SpawnSubAgentMetadata
  | WaitForMetadata
  | SetPlanMetadata
  | SendMessageToUserMetadata
  | RequestUserSignupMetadata
  | RequestUserApprovalMetadata
  | EnableWritePermissionsMetadata
  | ReadMessageHistoryMetadata
  | ProgressToolMetadata
  | SimpleToolMetadata;
