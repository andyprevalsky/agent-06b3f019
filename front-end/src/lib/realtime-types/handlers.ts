import type {
  DeleteMessagePayload,
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
} from './stream-payloads';
import type { AgentStateChangedPayload } from './bus-channel';
import type { AttentionRequestPayload } from './user-channel';

// =============================================================================
// Handler Types
// =============================================================================

/**
 * Typed handlers for agent channel events.
 */
export interface AgentChannelHandlers {
  onInsert?: (payload: InsertMessagePayload) => void;
  onUpdate?: (payload: UpdateAgentPayload) => void;
  onDelete?: (payload: DeleteMessagePayload) => void;
  onAssistantStream?: (payload: AssistantStreamPayload) => void;
  onPlanStream?: (payload: PlanStreamPayload) => void;
  onToolStream?: (payload: ToolStreamPayload) => void;
  onAttentionStream?: (payload: AttentionStreamPayload) => void;
  onAgentModeStarted?: (payload: AgentModeStartedPayload) => void;
  onBrowserSession?: (payload: BrowserSessionBindingPayload) => void;
}

/**
 * Typed handlers for bus channel events.
 */
export interface BusChannelHandlers {
  onUpdate?: (payload: UpdateAgentPayload) => void;
  onAgentStateChanged?: (payload: AgentStateChangedPayload) => void;
}

/**
 * Typed handlers for user channel events (deprecated - uses polling).
 */
export interface UserChannelHandlers {
  onInsert?: (payload: AttentionRequestPayload) => void;
  onUpdate?: (payload: AttentionRequestPayload) => void;
  onDelete?: (payload: { id: string }) => void;
}
