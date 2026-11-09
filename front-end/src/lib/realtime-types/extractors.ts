import { toDate } from '../localDateTime';
import type { FilePointer } from '../api';
import type { RealtimeBroadcastWrapper } from './wrapper';
import type {
  DeleteMessagePayload,
  InsertDeferredPayload,
  InsertMessagePayload,
  UpdateAgentPayload,
} from './message-payloads';
import type {
  AgentModeStartedPayload,
  AssistantStreamPayload,
  BrowserSessionBindingPayload,
  AttentionStreamPayload,
  PlanStreamPayload,
  ToolStreamPayload,
  UserUiActiveChangedPayload,
} from './stream-payloads';
import type { AgentStateChangedPayload } from './bus-channel';
import {
  validateUserUiActiveChangedPayload,
  validateAgentModeStartedPayload,
  validateAgentStateChangedPayload,
  validateAssistantStreamPayload,
  validateAttentionStreamPayload,
  validateBrowserSessionBindingPayload,
  validateInsertMessagePayload,
  validatePlanStreamPayload,
  validateToolStreamPayload,
  validateUpdateAgentPayload,
} from './validators';

/** Native Postgres broadcasts use UTC timestamp-without-zone columns; API frames use ISO. */
function normalizeDatabaseBroadcast(
  wrapper: unknown,
  table: 'Agent' | 'Message',
  timeField: 'updatedAt' | 'timestamp',
): unknown {
  if (typeof wrapper !== 'object' || wrapper === null) return wrapper;
  const payload = (wrapper as Record<string, unknown>).payload;
  if (typeof payload !== 'object' || payload === null) return wrapper;
  const envelope = payload as Record<string, unknown>;
  if (envelope.schema !== 'public' || envelope.table !== table) return wrapper;
  const raw = envelope.record;
  if (typeof raw !== 'object' || raw === null) return wrapper;
  const record = raw as Record<string, unknown>;
  const value = record[timeField];
  const date = typeof value === 'string' ? toDate(value) : null;
  // Route malformed native rows through the existing extraction error path.
  const normalized =
    date && (table !== 'Agent' || typeof record.id === 'string')
      ? {
          ...record,
          [timeField]: date.toISOString(),
          ...(table === 'Agent' ? { agentId: record.id } : {}),
        }
      : null;
  return { ...wrapper, payload: { ...envelope, record: normalized } };
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
  validator: (payload: unknown) => string | null,
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
    console.error(
      `❌ [Realtime] Unknown Message Type for ${eventType}: Invalid wrapper structure`,
      wrapper,
    );
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
  const record = extractAndValidate<InsertMessagePayload>(
    normalizeDatabaseBroadcast(wrapper, 'Message', 'timestamp'),
    'INSERT',
    validateInsertMessagePayload,
  );
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
  return extractAndValidate<UpdateAgentPayload>(
    normalizeDatabaseBroadcast(wrapper, 'Agent', 'updatedAt'),
    'UPDATE',
    validateUpdateAgentPayload,
  );
}

/**
 * Extract and validate INSERT_DEFERRED payload.
 */
export function extractInsertDeferredPayload(wrapper: unknown): InsertDeferredPayload | null {
  return extractAndValidate<InsertDeferredPayload>(wrapper, 'INSERT_DEFERRED', (p) => {
    if (typeof p !== 'object' || p === null) return 'Payload is not an object';
    const record = p as Record<string, unknown>;
    if (typeof record.agentId !== 'string') return 'Missing or invalid agentId';
    if (typeof record.id !== 'string' || record.id === '') return 'Missing or invalid id';
    if (typeof record.timestamp !== 'string') return 'Missing or invalid timestamp';
    if (!['SYSTEM', 'ASSISTANT', 'USER', 'TOOL'].includes(record.role as string)) {
      return 'Missing or invalid role';
    }
    if (typeof record.reason !== 'string' || record.reason === '') return 'Missing reason';
    if (record.preview !== undefined && typeof record.preview !== 'string') {
      return 'Invalid preview';
    }
    return null;
  });
}

/**
 * Extract an INSERT_ENCODED frame: the same committed record with its content
 * fields as one base64 JSON blob (sent when the plain frame was refused).
 * Decodes it, then applies the normal INSERT validation and transforms.
 */
export function extractInsertEncodedPayload(wrapper: unknown): InsertMessagePayload | null {
  const record = (wrapper as { payload?: { record?: Record<string, unknown> } } | null)?.payload
    ?.record;
  if (record?.encoding !== 'base64' || typeof record.data !== 'string') {
    console.error('❌ [Realtime] Unknown Message Type for INSERT_ENCODED: bad encoding', record);
    return null;
  }
  let content: Record<string, unknown>;
  try {
    const bytes = Uint8Array.from(atob(record.data), (char) => char.charCodeAt(0));
    content = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch (error) {
    console.error('❌ [Realtime] Undecodable INSERT_ENCODED payload', error);
    return null;
  }
  const { encoding: _encoding, data: _data, ...identity } = record;
  return extractInsertPayload({ payload: { record: { ...identity, ...content } } });
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
  return extractAndValidate<AssistantStreamPayload>(
    wrapper,
    'ASSISTANT_STREAM',
    validateAssistantStreamPayload,
  );
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
  return extractAndValidate<AttentionStreamPayload>(
    wrapper,
    'ATTENTION_STREAM',
    validateAttentionStreamPayload,
  );
}

/**
 * Extract and validate AGENT_STATE_CHANGED payload.
 */
export function extractAgentStateChangedPayload(wrapper: unknown): AgentStateChangedPayload | null {
  return extractAndValidate<AgentStateChangedPayload>(
    wrapper,
    'AGENT_STATE_CHANGED',
    validateAgentStateChangedPayload,
  );
}

/**
 * Extract and validate AGENT_MODE_STARTED payload.
 */
export function extractAgentModeStartedPayload(wrapper: unknown): AgentModeStartedPayload | null {
  return extractAndValidate<AgentModeStartedPayload>(
    wrapper,
    'AGENT_MODE_STARTED',
    validateAgentModeStartedPayload,
  );
}

/**
 * Extract and validate USER_UI_ACTIVE_CHANGED payload.
 */
export function extractUserUiActiveChangedPayload(
  wrapper: unknown,
): UserUiActiveChangedPayload | null {
  return extractAndValidate<UserUiActiveChangedPayload>(
    wrapper,
    'USER_UI_ACTIVE_CHANGED',
    validateUserUiActiveChangedPayload,
  );
}

/**
 * Extract and validate BROWSER_SESSION payload.
 */
export function extractBrowserSessionBindingPayload(
  wrapper: unknown,
): BrowserSessionBindingPayload | null {
  return extractAndValidate<BrowserSessionBindingPayload>(
    wrapper,
    'BROWSER_SESSION',
    validateBrowserSessionBindingPayload,
  );
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
