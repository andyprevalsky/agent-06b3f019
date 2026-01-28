import { supabase, getSession } from './supabase';
import { RealtimeChannel } from '@supabase/supabase-js';

// Import and re-export all types from realtime-types.ts
export {
  // Raw wrapper
  type RealtimeBroadcastWrapper,
  // Event type unions
  type AgentChannelEvent,
  type BusChannelEvent,
  type UserChannelEvent,
  // Agent channel payloads
  type MessageRole,
  type ToolStatus,
  type MessageMetadata,
  type BrowserActionType,
  type CodeActionType,
  type InsertMessagePayload,
  type UpdateAgentPayload,
  type DeleteMessagePayload,
  type AssistantStreamPayload,
  type PlanStreamPayload,
  type ToolStreamPayload,
  type AttentionStreamPayload,
  type AgentModeStartedPayload,
  // Tool-specific metadata types
  type ToolName,
  type BaseToolMetadata,
  type SpawnBrowserAgentMetadata,
  type SpawnClaudeCodeAgentMetadata,
  type SpawnSubAgentsMetadata,
  type SetPlanMetadata,
  type PlanArtifactData,
  type SendMessageToUserMetadata,
  type RequestUserSignupMetadata,
  type RequestUserApprovalMetadata,
  type EnableWritePermissionsMetadata,
  type ReadMessageHistoryMetadata,
  type ProgressToolMetadata,
  type SimpleToolMetadata,
  type ToolMessageMetadata,
  type ToolMessagePayload,
  // Bus channel payloads
  type AgentStateChangedPayload,
  type FailureContext,
  type TrajectoryStep,
  // User channel payloads (deprecated)
  type AttentionRequestPayload,
  // Handler types
  type AgentChannelHandlers,
  type BusChannelHandlers,
  type UserChannelHandlers,
  // Type guards
  isInsertMessagePayload,
  isAssistantStreamPayload,
  isAgentStateChangedPayload,
  isToolMessage,
  isSpawnBrowserAgentMessage,
  isSpawnClaudeCodeAgentMessage,
  isSetPlanMessage,
  isSendMessageToUserMessage,
  isRequestUserSignupMessage,
  // Strict extractors (with validation + error logging)
  extractInsertPayload,
  extractUpdatePayload,
  extractDeletePayload,
  extractAssistantStreamPayload,
  extractPlanStreamPayload,
  extractToolStreamPayload,
  extractAttentionStreamPayload,
  extractAgentStateChangedPayload,
  extractAgentModeStartedPayload,
  // Legacy utility (deprecated)
  extractRecord,
} from './realtime-types';

import {
  type AssistantStreamPayload,
  type PlanStreamPayload,
  type ToolStreamPayload,
  type AttentionStreamPayload,
  type InsertMessagePayload,
  type UpdateAgentPayload,
  type DeleteMessagePayload,
  type AgentStateChangedPayload,
  type AgentModeStartedPayload,
  extractInsertPayload,
  extractUpdatePayload,
  extractDeletePayload,
  extractAssistantStreamPayload,
  extractPlanStreamPayload,
  extractToolStreamPayload,
  extractAttentionStreamPayload,
  extractAgentStateChangedPayload,
  extractAgentModeStartedPayload,
} from './realtime-types';

// Legacy type aliases for backward compatibility
/** @deprecated Use AssistantStreamPayload instead */
export type StreamChunkPayload = AssistantStreamPayload;

/**
 * Generic event handler type
 */
type EventHandler = (payload: any) => void;

/**
 * Event handlers map: event name -> handler function
 */
export type EventHandlers = Record<string, EventHandler>;

/**
 * Generic channel subscription function.
 * Handles auth, creates channel, attaches event handlers, and manages subscription lifecycle.
 *
 * @param channelName - The full channel name (e.g., "agent:abc123", "bus:xyz789")
 * @param eventHandlers - Map of event names to handler functions
 * @param logPrefix - Prefix for log messages (e.g., "Agent", "Bus")
 * @returns The realtime channel (call unsubscribe to clean up)
 */
export async function subscribeToChannel(
  channelName: string,
  eventHandlers: EventHandlers,
  logPrefix: string = 'Channel'
): Promise<RealtimeChannel> {
  // Verify session exists
  const session = getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }

  // IMPORTANT: Call setAuth immediately before creating each channel
  // This ensures the new channel gets the correct token in its join payload.
  // Supabase doesn't automatically apply setAuth to new channels created later.
  // See: https://github.com/supabase/realtime-js/pull/126
  console.log(`[Realtime] subscribeToChannel(${channelName}) - calling setAuth with user token`);
  console.log(`[Realtime] Token preview: ${session.access_token.slice(0, 50)}...`);
  await supabase.realtime.setAuth(session.access_token);
  console.log(`[Realtime] setAuth completed for ${channelName}`);

  // Private channel - requires auth, worker uses service_role_key to broadcast
  const channel = supabase.channel(channelName, {
    config: { private: true }
  });

  // Attach all event handlers
  for (const [eventName, handler] of Object.entries(eventHandlers)) {
    channel.on('broadcast', { event: eventName }, handler);
  }

  const shortName = channelName.length > 16 ? `${channelName.slice(0, 16)}...` : channelName;

  let resolved = false;
  return new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      // Log all status changes for debugging
      console.log(`🔌 ${logPrefix} channel (${shortName}) status: ${status}`);

      if (status === 'SUBSCRIBED') {
        console.log(`✅ Connected to ${channelName}`);
        resolved = true;
        resolve(channel);
      } else if (status === 'CHANNEL_ERROR') {
        console.error(`❌ Disconnected from ${channelName} - CHANNEL_ERROR`);
        if (!resolved) reject(new Error(`Channel error for ${channelName}`));
      } else if (status === 'TIMED_OUT') {
        console.error(`❌ Disconnected from ${channelName} - TIMED_OUT`);
        if (!resolved) reject(new Error(`Subscription timed out for ${channelName}`));
      } else if (status === 'CLOSED') {
        console.warn(`🔴 Disconnected from ${channelName} - CLOSED`);
        if (!resolved) reject(new Error(`Channel closed for ${channelName}`));
      }
    });
  });
}

/**
 * Handlers for agent channel events.
 * Uses typed payloads from realtime-types.ts.
 */
export interface AgentHandlers {
  onInsert?: (payload: InsertMessagePayload) => void;
  onUpdate?: (payload: UpdateAgentPayload) => void;
  onDelete?: (payload: DeleteMessagePayload) => void;
  onAssistantStream?: (payload: AssistantStreamPayload) => void;
  onPlanStream?: (payload: PlanStreamPayload) => void;
  onAttentionStream?: (payload: AttentionStreamPayload) => void;
  onToolStream?: (payload: ToolStreamPayload) => void;
  onAgentModeStarted?: () => void;
}

/**
 * Subscribe to a specific agent's channel.
 * Receives broadcasts for messages and agent updates.
 *
 * All payloads are extracted from the Supabase broadcast wrapper and typed.
 * See realtime-types.ts for payload documentation.
 *
 * @param agentId - The agent ID to subscribe to
 * @param handlers - Typed callbacks for channel events
 * @returns The realtime channel (call unsubscribe to clean up)
 */
export async function subscribeToAgent(
  agentId: string,
  handlers: AgentHandlers
): Promise<RealtimeChannel> {
  const eventHandlers: EventHandlers = {};

  if (handlers.onInsert) {
    eventHandlers['INSERT'] = (wrapper: unknown) => {
      const record = extractInsertPayload(wrapper);
      if (record) handlers.onInsert!(record);
    };
  }
  if (handlers.onUpdate) {
    eventHandlers['UPDATE'] = (wrapper: unknown) => {
      const record = extractUpdatePayload(wrapper);
      if (record) handlers.onUpdate!(record);
    };
  }
  if (handlers.onDelete) {
    eventHandlers['DELETE'] = (wrapper: unknown) => {
      const record = extractDeletePayload(wrapper);
      if (record) handlers.onDelete!(record);
    };
  }
  if (handlers.onAssistantStream) {
    eventHandlers['ASSISTANT_STREAM'] = (wrapper: unknown) => {
      const record = extractAssistantStreamPayload(wrapper);
      if (record) handlers.onAssistantStream!(record);
    };
  }
  if (handlers.onPlanStream) {
    eventHandlers['PLAN_STREAM'] = (wrapper: unknown) => {
      const record = extractPlanStreamPayload(wrapper);
      if (record) handlers.onPlanStream!(record);
    };
  }
  if (handlers.onAttentionStream) {
    eventHandlers['ATTENTION_STREAM'] = (wrapper: unknown) => {
      const record = extractAttentionStreamPayload(wrapper);
      if (record) handlers.onAttentionStream!(record);
    };
  }
  if (handlers.onToolStream) {
    eventHandlers['TOOL_STREAM'] = (wrapper: unknown) => {
      const record = extractToolStreamPayload(wrapper);
      if (record) handlers.onToolStream!(record);
    };
  }
  if (handlers.onAgentModeStarted) {
    eventHandlers['AGENT_MODE_STARTED'] = (wrapper: unknown) => {
      const record = extractAgentModeStartedPayload(wrapper);
      if (record) handlers.onAgentModeStarted!(record);
    };
  }

  return subscribeToChannel(`agent:${agentId}`, eventHandlers, 'Agent');
}

/**
 * Handlers for attention request channel events
 */
export interface AttentionRequestHandlers {
  onInsert?: (payload: any) => void;
  onUpdate?: (payload: any) => void;
  onDelete?: (payload: any) => void;
}

/**
 * Subscribe to attention requests for a specific user
 *
 * @param userId - The user ID to subscribe to
 * @param handlers - Callbacks for INSERT/UPDATE/DELETE events
 * @returns The realtime channel (call unsubscribe to clean up)
 */
export async function subscribeToAttentionRequests(
  userId: string,
  handlers: AttentionRequestHandlers
): Promise<RealtimeChannel> {
  const eventHandlers: EventHandlers = {};

  if (handlers.onInsert) {
    eventHandlers['INSERT'] = handlers.onInsert;
  }
  if (handlers.onUpdate) {
    eventHandlers['UPDATE'] = handlers.onUpdate;
  }
  if (handlers.onDelete) {
    eventHandlers['DELETE'] = handlers.onDelete;
  }

  return subscribeToChannel(`user:${userId}`, eventHandlers, 'User attention');
}

/**
 * Handlers for bus channel events (sub-agent tree state).
 * Uses typed payloads from realtime-types.ts.
 */
export interface BusHandlers {
  onAgentStateChanged?: (payload: AgentStateChangedPayload) => void;
}

/**
 * Subscribe to a bus channel for sub-agent tree state updates.
 *
 * See realtime-types.ts for AgentStateChangedPayload documentation.
 *
 * @param busId - The bus ID (typically root agent's ID)
 * @param handlers - Typed callbacks for AGENT_STATE_CHANGED events
 * @returns The realtime channel (call unsubscribe to clean up)
 */
export async function subscribeToBus(
  busId: string,
  handlers: BusHandlers
): Promise<RealtimeChannel> {
  const eventHandlers: EventHandlers = {};

  if (handlers.onAgentStateChanged) {
    eventHandlers['AGENT_STATE_CHANGED'] = (wrapper: unknown) => {
      const record = extractAgentStateChangedPayload(wrapper);
      if (record) handlers.onAgentStateChanged!(record);
    };
  }

  return subscribeToChannel(`bus:${busId}`, eventHandlers, 'Bus');
}

/**
 * Unsubscribe from a channel
 *
 * @param channel - The channel to unsubscribe from
 */
export function unsubscribe(channel: RealtimeChannel | null) {
  if (!channel) return;
  supabase.removeChannel(channel);
}
