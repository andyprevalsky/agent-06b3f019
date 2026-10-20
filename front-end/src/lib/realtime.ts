import { supabase, getSession, ensureFreshRealtimeAuth } from './supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import { USE_PRIVATE_REALTIME_CHANNELS } from './realtimeConfig';

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
  type BrowserSessionBindingPayload,
  // Tool-specific metadata types
  type ToolName,
  type BaseToolMetadata,
  type SpawnBrowserAgentMetadata,
  type SpawnClaudeCodeAgentMetadata,
  type SpawnSubAgentMetadata,
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
  extractBrowserSessionBindingPayload,
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
  type BrowserSessionBindingPayload,
  type UserUiActiveChangedPayload,
  extractInsertPayload,
  extractUpdatePayload,
  extractDeletePayload,
  extractAssistantStreamPayload,
  extractPlanStreamPayload,
  extractToolStreamPayload,
  extractAttentionStreamPayload,
  extractAgentStateChangedPayload,
  extractAgentModeStartedPayload,
  extractBrowserSessionBindingPayload,
  extractUserUiActiveChangedPayload,
} from './realtime-types';

// Legacy type aliases for backward compatibility
/** @deprecated Use AssistantStreamPayload instead */
export type StreamChunkPayload = AssistantStreamPayload;

/**
 * Generic event handler type
 */
type EventHandler = (payload: unknown) => void;

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
  logPrefix: string = 'Channel',
  onDisconnect?: () => void,
): Promise<RealtimeChannel> {
  // Verify session exists
  const session = getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }

  // Bind the realtime socket's auth token before creating the channel so the
  // private-channel join payload carries it (see RealtimeChannel._rejoin, which
  // only attaches access_token when socket.accessTokenValue is populated).
  //
  // useAuth's setRealtimeAuth() binds the token on sign-in, but autoRefreshToken
  // is off, so a token rotation between then and now would leave the socket
  // signing joins with a STALE token — the private-channel join for agent:<id>
  // (which the server authorizes against the current JWT) then fails Unauthorized
  // and doesn't recover until the next auth event. ensureFreshRealtimeAuth()
  // re-binds only when the current session token differs from what's bound, so a
  // pre-subscribe rebind is a no-op in the common case yet guarantees the join
  // signs with a live token. See: https://github.com/supabase/realtime-js/pull/126
  await ensureFreshRealtimeAuth();

  // Private channels are the production default (RLS checks the Supabase
  // managed DB). Dev and explicitly-local production bundles use public
  // channels because their agents live only in the workspace Postgres DB.
  const channel = supabase.channel(channelName, {
    config: { private: USE_PRIVATE_REALTIME_CHANNELS },
  });

  // Attach all event handlers
  for (const [eventName, handler] of Object.entries(eventHandlers)) {
    channel.on('broadcast', { event: eventName }, handler);
  }

  const shortName = channelName.length > 16 ? `${channelName.slice(0, 16)}...` : channelName;

  let resolved = false;
  let disconnectNotified = false;
  return new Promise((resolve, reject) => {
    // realtime-js passes a second `err` argument on CHANNEL_ERROR/TIMED_OUT
    // (the phx_join error reply, or the normalized transport reason). We MUST
    // surface it — a bare "CHANNEL_ERROR" hides whether the join was rejected
    // for auth/RLS reasons vs a transport drop, which is exactly what's needed
    // to diagnose intermittent subscription failures.
    channel.subscribe((status, err) => {
      // Log all status changes for debugging
      console.log(`🔌 ${logPrefix} channel (${shortName}) status: ${status}`);

      if (status === 'SUBSCRIBED') {
        console.log(`✅ Connected to ${channelName}`);
        resolved = true;
        disconnectNotified = false; // Reset on successful (re)join
        resolve(channel);
      } else if (status === 'CHANNEL_ERROR') {
        const reason = err?.message || 'unknown';
        console.error(
          `❌ Disconnected from ${channelName} - CHANNEL_ERROR: ${reason}`,
          err?.cause ?? err ?? '',
        );
        if (!resolved) reject(new Error(`Channel error for ${channelName}: ${reason}`));
        else if (onDisconnect && !disconnectNotified) {
          disconnectNotified = true;
          onDisconnect();
        }
      } else if (status === 'TIMED_OUT') {
        const reason = err?.message || 'unknown';
        console.error(`❌ Disconnected from ${channelName} - TIMED_OUT: ${reason}`, err ?? '');
        if (!resolved) reject(new Error(`Subscription timed out for ${channelName}: ${reason}`));
        else if (onDisconnect && !disconnectNotified) {
          disconnectNotified = true;
          onDisconnect();
        }
      } else if (status === 'CLOSED') {
        console.warn(`🔴 Disconnected from ${channelName} - CLOSED`);
        if (!resolved) reject(new Error(`Channel closed for ${channelName}`));
        else if (onDisconnect && !disconnectNotified) {
          disconnectNotified = true;
          onDisconnect();
        }
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
  onAgentModeStarted?: (payload: AgentModeStartedPayload) => void;
  onBrowserSession?: (payload: BrowserSessionBindingPayload) => void;
  /** A code agent in this tree activated a new Rose UI version (rose-ui publish). */
  onUserUiActiveChanged?: (payload: UserUiActiveChangedPayload) => void;
  onDisconnect?: () => void;
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
  handlers: AgentHandlers,
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

  if (handlers.onBrowserSession) {
    eventHandlers['BROWSER_SESSION'] = (wrapper: unknown) => {
      const record = extractBrowserSessionBindingPayload(wrapper);
      if (record) handlers.onBrowserSession!(record);
    };
  }
  if (handlers.onUserUiActiveChanged) {
    eventHandlers['USER_UI_ACTIVE_CHANGED'] = (wrapper: unknown) => {
      const record = extractUserUiActiveChangedPayload(wrapper);
      if (record) handlers.onUserUiActiveChanged!(record);
    };
  }

  return subscribeToChannel(`agent:${agentId}`, eventHandlers, 'Agent', handlers.onDisconnect);
}

/**
 * Handlers for attention request channel events
 */
export interface AttentionRequestHandlers {
  onInsert?: (payload: unknown) => void;
  onUpdate?: (payload: unknown) => void;
  onDelete?: (payload: unknown) => void;
  onDisconnect?: () => void;
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
  handlers: AttentionRequestHandlers,
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

  return subscribeToChannel(
    `user:${userId}`,
    eventHandlers,
    'User attention',
    handlers.onDisconnect,
  );
}

/**
 * Handlers for bus channel events (sub-agent tree state).
 * Uses typed payloads from realtime-types.ts.
 */
export interface BusHandlers {
  onAgentStateChanged?: (payload: AgentStateChangedPayload) => void;
  onDisconnect?: () => void;
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
  handlers: BusHandlers,
): Promise<RealtimeChannel> {
  const eventHandlers: EventHandlers = {};

  if (handlers.onAgentStateChanged) {
    eventHandlers['AGENT_STATE_CHANGED'] = (wrapper: unknown) => {
      const record = extractAgentStateChangedPayload(wrapper);
      if (record) handlers.onAgentStateChanged!(record);
    };
  }

  return subscribeToChannel(`bus:${busId}`, eventHandlers, 'Bus', handlers.onDisconnect);
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
