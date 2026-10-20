// =============================================================================
// Validation Functions (internal)
//
// These shape validators return an error message string when the payload fails
// validation, or `null` when it is well-formed. They are consumed by the
// extractors in extractors.ts.
// =============================================================================

/**
 * Validate InsertMessagePayload structure.
 * Returns error message if invalid, null if valid.
 */
export function validateInsertMessagePayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string')
    return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.id !== 'string') return `Missing or invalid 'id' (got ${typeof p.id})`;
  if (typeof p.timestamp !== 'string')
    return `Missing or invalid 'timestamp' (got ${typeof p.timestamp})`;
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
    if (typeof meta.toolCallId !== 'string')
      return `TOOL metadata missing 'toolCallId' (got ${typeof meta.toolCallId})`;
    if (typeof meta.toolName !== 'string')
      return `TOOL metadata missing 'toolName' (got ${typeof meta.toolName})`;
    if (typeof meta.toolStatus !== 'string')
      return `TOOL metadata missing 'toolStatus' (got ${typeof meta.toolStatus})`;
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
export function validateUpdateAgentPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  // UPDATE payloads are partial - all fields optional, but if present must be correct type
  const p = payload as Record<string, unknown>;
  if (p.title !== undefined && p.title !== null && typeof p.title !== 'string') {
    return `Invalid 'title' type (got ${typeof p.title})`;
  }
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
export function validateAssistantStreamPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string')
    return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.stream_id !== 'string')
    return `Missing or invalid 'stream_id' (got ${typeof p.stream_id})`;
  if (typeof p.delta !== 'string') return `Missing or invalid 'delta' (got ${typeof p.delta})`;
  if (typeof p.done !== 'boolean') return `Missing or invalid 'done' (got ${typeof p.done})`;
  if (p.clear_on_done !== undefined && typeof p.clear_on_done !== 'boolean') {
    return `Invalid 'clear_on_done' type (got ${typeof p.clear_on_done})`;
  }
  if (typeof p.sequence !== 'number')
    return `Missing or invalid 'sequence' (got ${typeof p.sequence})`;
  if (p.llm_started_at_ms !== undefined && typeof p.llm_started_at_ms !== 'number') {
    return `Invalid 'llm_started_at_ms' type (got ${typeof p.llm_started_at_ms})`;
  }
  if (p.subAgentId !== undefined && typeof p.subAgentId !== 'string') {
    return `Invalid 'subAgentId' type (got ${typeof p.subAgentId})`;
  }
  if (p.char_count !== undefined && typeof p.char_count !== 'number') {
    return `Invalid 'char_count' type (got ${typeof p.char_count})`;
  }
  return null;
}

/**
 * Validate PlanStreamPayload structure.
 * Returns error message if invalid, null if valid.
 */
export function validatePlanStreamPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string')
    return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.stream_id !== 'string')
    return `Missing or invalid 'stream_id' (got ${typeof p.stream_id})`;
  if (typeof p.tool_call_id !== 'string')
    return `Missing or invalid 'tool_call_id' (got ${typeof p.tool_call_id})`;
  if (typeof p.title !== 'string') return `Missing or invalid 'title' (got ${typeof p.title})`;
  if (p.char_count !== undefined && typeof p.char_count !== 'number') {
    return `Invalid 'char_count' type (got ${typeof p.char_count})`;
  }
  if (p.llm_started_at_ms !== undefined && typeof p.llm_started_at_ms !== 'number') {
    return `Invalid 'llm_started_at_ms' type (got ${typeof p.llm_started_at_ms})`;
  }
  return null;
}

/**
 * Validate ToolStreamPayload structure.
 * Returns error message if invalid, null if valid.
 */
export function validateToolStreamPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string')
    return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.stream_id !== 'string')
    return `Missing or invalid 'stream_id' (got ${typeof p.stream_id})`;
  if (typeof p.tool_call_id !== 'string')
    return `Missing or invalid 'tool_call_id' (got ${typeof p.tool_call_id})`;
  if (typeof p.tool_name !== 'string')
    return `Missing or invalid 'tool_name' (got ${typeof p.tool_name})`;
  if (typeof p.title !== 'string') return `Missing or invalid 'title' (got ${typeof p.title})`;
  if (
    p.status !== undefined &&
    !['IN_PROGRESS', 'FINISHED', 'ERROR'].includes(p.status as string)
  ) {
    return `Invalid 'status' value (got ${String(p.status)})`;
  }
  if (p.char_count !== undefined && typeof p.char_count !== 'number') {
    return `Invalid 'char_count' type (got ${typeof p.char_count})`;
  }
  if (p.llm_started_at_ms !== undefined && typeof p.llm_started_at_ms !== 'number') {
    return `Invalid 'llm_started_at_ms' type (got ${typeof p.llm_started_at_ms})`;
  }
  if (p.subAgentId !== undefined && typeof p.subAgentId !== 'string') {
    return `Invalid 'subAgentId' type (got ${typeof p.subAgentId})`;
  }
  if (p.is_claude !== undefined && typeof p.is_claude !== 'boolean') {
    return `Invalid 'is_claude' type (got ${typeof p.is_claude})`;
  }
  if (p.is_gpt !== undefined && typeof p.is_gpt !== 'boolean') {
    return `Invalid 'is_gpt' type (got ${typeof p.is_gpt})`;
  }
  return null;
}

/**
 * Validate AttentionStreamPayload structure.
 * Returns error message if invalid, null if valid.
 */
export function validateAttentionStreamPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string')
    return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.stream_id !== 'string')
    return `Missing or invalid 'stream_id' (got ${typeof p.stream_id})`;
  if (typeof p.tool_call_id !== 'string')
    return `Missing or invalid 'tool_call_id' (got ${typeof p.tool_call_id})`;
  if (typeof p.message !== 'string')
    return `Missing or invalid 'message' (got ${typeof p.message})`;
  if (typeof p.is_question !== 'boolean')
    return `Missing or invalid 'is_question' (got ${typeof p.is_question})`;
  if (typeof p.done !== 'boolean') return `Missing or invalid 'done' (got ${typeof p.done})`;
  if (typeof p.sequence !== 'number')
    return `Missing or invalid 'sequence' (got ${typeof p.sequence})`;
  return null;
}

/**
 * Validate AgentStateChangedPayload structure.
 * Returns error message if invalid, null if valid.
 */
export function validateAgentStateChangedPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string')
    return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  if (typeof p.goal !== 'string') return `Missing or invalid 'goal' (got ${typeof p.goal})`;
  if (typeof p.status !== 'string') return `Missing or invalid 'status' (got ${typeof p.status})`;
  if (typeof p.progress !== 'number')
    return `Missing or invalid 'progress' (got ${typeof p.progress})`;
  if (!Array.isArray(p.toolsInUse))
    return `Missing or invalid 'toolsInUse' (got ${typeof p.toolsInUse})`;
  if (typeof p.messageCount !== 'number')
    return `Missing or invalid 'messageCount' (got ${typeof p.messageCount})`;
  return null;
}

/**
 * Validate AgentModeStartedPayload structure.
 * Returns error message if invalid, null if valid.
 */
export function validateAgentModeStartedPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.agentId !== 'string')
    return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  return null;
}

export function validateUserUiActiveChangedPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.versionId !== 'string' || p.versionId === '')
    return `Missing or invalid 'versionId' (got ${typeof p.versionId})`;
  if (typeof p.agentId !== 'string')
    return `Missing or invalid 'agentId' (got ${typeof p.agentId})`;
  return null;
}

/**
 * Validate BrowserSessionBindingPayload structure.
 * Returns error message if invalid, null if valid.
 */
export function validateBrowserSessionBindingPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.taskId !== 'string') return `Missing or invalid 'taskId' (got ${typeof p.taskId})`;
  if (typeof p.sessionId !== 'string')
    return `Missing or invalid 'sessionId' (got ${typeof p.sessionId})`;
  if (p.debugUrl !== null && typeof p.debugUrl !== 'string')
    return `Invalid 'debugUrl' (got ${typeof p.debugUrl})`;
  if (typeof p.status !== 'string') return `Missing or invalid 'status' (got ${typeof p.status})`;
  if (p.live !== null && typeof p.live !== 'boolean')
    return `Invalid 'live' (got ${typeof p.live})`;
  if (typeof p.asOf !== 'number' || !Number.isFinite(p.asOf))
    return `Missing or invalid 'asOf' (got ${typeof p.asOf})`;
  return null;
}
