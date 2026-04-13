/**
 * Hooks layer for the terminal-component-group domain.
 *
 * Re-exports hooks consumed by terminal UI components. Components import from
 * this file instead of reaching into shared hooks directly.
 *
 * Also re-exports imperative API functions used by components in event handlers.
 * This keeps the dependency chain forward-only: components -> hooks -> api.
 */

// ── Hooks ─────────────────────────────────────────────────────────────────
export { useToast } from '@/hooks/use-toast';
export { useAuth } from '@/hooks/useAuth';
export { useAppData } from '@/hooks/useAppData';
export type { Model } from '@/hooks/useAppData';
export { useAnimatedCounter } from '@/hooks/useAnimatedCounter';
export { useSmallTileAnimations } from '@/hooks/useSmallTileAnimations';
export {
  useAgentTree,
  filterTreeBySpawn,
  getCircleState,
  getStatusText,
  type TreeNode,
} from '@/hooks/useAgentTree';
export { useAgentContext, type StreamingBubble } from '@/contexts/AgentContext';

// ── Imperative API functions used by components in event handlers ──────────
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
  subscribeToAttentionRequests,
  unsubscribe,
  getStoredSession,
} from './api';

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
  FailureContext,
  PlanTask,
} from './api';
