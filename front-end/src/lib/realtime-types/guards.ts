import type { FilePointer } from '../api';
import type { InsertMessagePayload, ToolMessagePayload } from './message-payloads';
import type {
  SendMessageToUserMetadata,
  SetPlanMetadata,
  SpawnAgentMetadata,
  SpawnBrowserAgentMetadata,
  SpawnClaudeCodeAgentMetadata,
  RequestUserSignupMetadata,
} from './tool-metadata';
import type { AssistantStreamPayload } from './stream-payloads';
import type { AgentStateChangedPayload } from './bus-channel';
import type { AgentMessageMetadata, AgentNotificationMetadata } from './message-metadata';

// =============================================================================
// Tool Message Type Guards
// =============================================================================

/**
 * Type guard to check if a message is a TOOL message.
 * NOTE: Only call on validated InsertMessagePayload from extractInsertPayload().
 * TOOL messages are guaranteed to have metadata with toolName/toolCallId/toolStatus.
 */
export function isToolMessage(
  msg: InsertMessagePayload,
): msg is InsertMessagePayload & ToolMessagePayload {
  if (msg.role !== 'TOOL') return false;
  if (!msg.metadata || typeof msg.metadata.toolName !== 'string') {
    console.error(
      '❌ [Realtime] isToolMessage called on invalid TOOL message (missing metadata.toolName)',
      msg,
    );
    return false;
  }
  return true;
}

/**
 * Type guard for spawn_browser_agent messages.
 */
export function isSpawnBrowserAgentMessage(
  msg: InsertMessagePayload,
): msg is InsertMessagePayload & ToolMessagePayload<SpawnBrowserAgentMetadata> {
  return (
    msg.role === 'TOOL' &&
    msg.metadata !== null &&
    msg.metadata !== undefined &&
    msg.metadata.toolName === 'spawn_browser_agent'
  );
}

/**
 * Type guard for spawn_claude_code_agent messages.
 */
export function isSpawnClaudeCodeAgentMessage(
  msg: InsertMessagePayload,
): msg is InsertMessagePayload & ToolMessagePayload<SpawnClaudeCodeAgentMetadata> {
  return (
    msg.role === 'TOOL' &&
    msg.metadata !== null &&
    msg.metadata !== undefined &&
    msg.metadata.toolName === 'spawn_claude_code_agent'
  );
}

/**
 * Type guard for spawn_agent messages (unified: explore/browser/code/general_purpose).
 */
export function isSpawnAgentMessage(
  msg: InsertMessagePayload,
): msg is InsertMessagePayload & ToolMessagePayload<SpawnAgentMetadata> {
  return (
    msg.role === 'TOOL' &&
    msg.metadata !== null &&
    msg.metadata !== undefined &&
    msg.metadata.toolName === 'spawn_agent'
  );
}

/**
 * Type guard for explore agent messages (spawn_agent with agentType=explore).
 */
export function isExploreAgentMessage(msg: InsertMessagePayload): boolean {
  return isSpawnAgentMessage(msg) && (msg.metadata as SpawnAgentMetadata).agentType === 'explore';
}

/**
 * Type guard for set_plan messages.
 */
export function isSetPlanMessage(
  msg: InsertMessagePayload,
): msg is InsertMessagePayload & ToolMessagePayload<SetPlanMetadata> {
  return (
    msg.role === 'TOOL' &&
    msg.metadata !== null &&
    msg.metadata !== undefined &&
    msg.metadata.toolName === 'set_plan'
  );
}

/**
 * Type guard for send_message_to_user messages.
 */
export function isSendMessageToUserMessage(
  msg: InsertMessagePayload,
): msg is InsertMessagePayload & ToolMessagePayload<SendMessageToUserMetadata> {
  if (msg.role !== 'TOOL' || msg.metadata === null || msg.metadata === undefined) return false;
  return (
    msg.metadata.toolName === 'send_message_to_user' ||
    msg.metadata.toolName === 'send_message_to_user_execute_phase'
  );
}

/**
 * Type guard for request_user_signup messages.
 */
export function isRequestUserSignupMessage(
  msg: InsertMessagePayload,
): msg is InsertMessagePayload & ToolMessagePayload<RequestUserSignupMetadata> {
  return (
    msg.role === 'TOOL' &&
    msg.metadata !== null &&
    msg.metadata !== undefined &&
    msg.metadata.toolName === 'request_user_signup'
  );
}

/**
 * Type guard for ASSISTANT messages with file attachments.
 * These are output files from tools like Claude Code.
 */
export function isAssistantFileMessage(
  msg: InsertMessagePayload,
): msg is InsertMessagePayload & { file_pointer: FilePointer } {
  return msg.role === 'ASSISTANT' && msg.file_pointer != null;
}

// =============================================================================
// Payload Shape Guards
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
    (p.clear_on_done === undefined || typeof p.clear_on_done === 'boolean') &&
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
// Agent-to-agent Row Guards
// =============================================================================

const CODEX_MESSAGE_TYPES = new Set(['MESSAGE', 'NEW_TASK']);
const CODEX_COMPLETION_TYPES = new Set(['FINAL_ANSWER', 'FAILED']);

/** True when a message's metadata marks it as an agent-to-agent message. */
export function isAgentMessageMetadata<T extends Record<string, unknown>>(
  metadata: T | null | undefined,
): metadata is T & AgentMessageMetadata {
  if (!metadata) return false;
  if (CODEX_MESSAGE_TYPES.has(String(metadata.messageType ?? ''))) return true;
  return metadata.agentMessage === true && typeof metadata.fromAgentId === 'string';
}

/** True when a message's metadata marks it as a sub-agent completion. */
export function isAgentNotificationMetadata<T extends Record<string, unknown>>(
  metadata: T | null | undefined,
): metadata is T & AgentNotificationMetadata {
  if (!metadata) return false;
  return (
    metadata.agentNotification === true ||
    CODEX_COMPLETION_TYPES.has(String(metadata.messageType ?? ''))
  );
}
