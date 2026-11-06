import type { Agent, FilePointer } from '../api';
import type { MessageMetadata, MessageRole } from './message-metadata';
import type { ToolMessageMetadata } from './tool-metadata';

// =============================================================================
// INSERT Event Payload
// =============================================================================

/**
 * INSERT event payload - New message from database.
 * Sent via Supabase Realtime when a message is inserted.
 */
export interface InsertMessagePayload {
  agentId: string; // Used to filter messages for correct agent
  id: string;
  timestamp: string; // ISO 8601 format
  text: string;
  role: MessageRole;
  metadata?: MessageMetadata | null;
  file_pointer?: FilePointer | null; // File attachment (OAI-style: one file per message)
}

/**
 * Typed TOOL message payload with discriminated union on toolName.
 */
export interface ToolMessagePayload<
  T extends ToolMessageMetadata = ToolMessageMetadata,
> extends InsertMessagePayload {
  id: string;
  timestamp: string;
  text: string;
  role: 'TOOL';
  metadata: T & MessageMetadata;
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
  agentId?: string;
  title?: string | null;
  progress?: number;
  progressEstimate?: import('../api/types').ProgressEstimate | null;
  taskId?: string;
  taskProgressEstimates?: Record<string, import('../api/types').ProgressEstimate>;
  status?: Agent['status'];
  statusMessage?: string | null;
  model?: string;
  tokenCount?: number;
  tokensIn?: number;
  tokensOut?: number;
  contextSize?: number;
  messageCount?: number;
  treeCostCents?: number; // Real-time tree cost updates (for price limit feature)
  updatedAt?: string;
  userControlRevision?: number;
  temporalWorkflowId?: string | null;
}

/**
 * INSERT_DEFERRED event payload - a committed message that is not streamed in
 * full: its frame was refused (e.g. by an edge WAF rule), or it is larger than
 * the backend's 8 KB live cap. It never carries the full `text`. `reason` (plus
 * `preview`, the opening characters of an oversized row) stands in for the body
 * until the client reads the row by ID from the API. Oversized notices keep the
 * small metadata fields; refused ones keep only the tool lifecycle.
 */
export interface InsertDeferredPayload {
  agentId: string;
  id: string;
  timestamp: string;
  role: MessageRole;
  reason: string;
  preview?: string;
  metadata?: MessageMetadata;
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
