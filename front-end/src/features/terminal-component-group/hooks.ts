/**
 * Hooks layer for the terminal-component-group domain.
 *
 * Re-exports hooks and imperative API functions consumed by terminal UI
 * components. Components import from this file (hooks + API functions) and
 * from types.ts (domain-specific types). This keeps the dependency chain
 * forward-only: components -> hooks -> api -> shared.
 */

// ── React Hooks ───────────────────────────────────────────────────────────
export { useToast } from '@/hooks/use-toast';
export { useAuth } from '@/features/auth';
export { useAppData } from '@/hooks/appDataContext';
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
export {
  useAgentContext,
  AgentContext,
  type StreamingBubble,
  type StreamingPlan,
  type StreamingAttention,
  type StreamingTool,
  type AgentContextValue,
} from '@/features/agent-context';

// ── Pure utilities re-exported so components can reach them via hooks.ts ──
export { deduplicateToolMessages } from './hooks/deduplicateToolMessages';

// ── Imperative API functions (used by components in event handlers) ───────
export {
  respondToAttentionRequest,
  completeAuthAssistanceRequest,
  refreshAuthAssistanceSession,
  rejectAttentionRequest,
  skipAttentionRequest,
  getAttentionRequests,
  updateAgent,
  deleteAgent,
  archiveAgent,
  unarchiveAgent,
  getArchivedAgents,
  postMessage,
  startAgent,
  signalSignupCompleted,
  signalSignupDismissed,
  getPeople,
  getTools,
  generateLLMJudgePrompt,
  getAttachmentUrl,
  uploadAttachment,
  resumeBrowserSession,
  MAX_FILE_SIZE,
  MAX_TOTAL_ATTACHMENTS_SIZE,
  subscribeToAttentionRequests,
  unsubscribe,
  getStoredSession,
  fetchCodeAgentSession,
  fetchClaudeCodeSession,
  fetchCreditsUsage,
  fetchPublicAsset,
  fetchTestPromptCatalog,
  fetchTestPaymentPublicUrl,
  submitFeedback,
  reportAgentBug,
  uploadBugReportScreenshot,
  downloadAttachmentAsBlob,
  downloadAttachmentAsText,
  fetchPhoneCallRecording,
} from './api';

// ── API types (used by components alongside the functions above) ──────────
export type {
  Agent,
  AgentDetail,
  AttentionRequest,
  Message,
  FilePointer,
  OutputSchema,
  OutputSchemaField,
  ResponseSchemaField,
  Tool,
  PeoplePaginatedResponse,
  Person,
  FailureContext,
  PlanTask,
} from './api';
