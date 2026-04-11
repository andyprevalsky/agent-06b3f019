/**
 * API layer for the terminal-component-group domain.
 *
 * Re-exports API functions consumed by terminal UI components. Components import
 * from this file instead of reaching into shared/lib directly. This establishes
 * the API boundary so cross-cutting changes to the client are isolated here.
 */

export {
  respondToAttentionRequest,
  rejectAttentionRequest,
  skipAttentionRequest,
  updateAgent,
  deleteAgent,
  postMessage,
  startAgent,
  signalSignupCompleted,
  signalSignupDismissed,
  getPeople,
  getTools,
  generateLLMJudgePrompt,
  getAttachmentUrl,
  uploadAttachment,
  MAX_FILE_SIZE,
  MAX_TOTAL_ATTACHMENTS_SIZE,
} from '@/lib/api';

export type {
  Agent,
  AgentDetail,
  Message,
  FilePointer,
  OutputSchema,
  OutputSchemaField,
  ResponseSchemaField,
  Tool,
  PeoplePaginatedResponse,
} from '@/lib/api';

export { subscribeToAttentionRequests, unsubscribe } from '@/lib/realtime';
export type { FailureContext } from '@/lib/realtime';
export type { PlanTask } from '@/lib/realtime-types';

export { getStoredSession } from '@/lib/supabase';
