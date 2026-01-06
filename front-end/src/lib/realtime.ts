import { supabase } from './supabase';
import { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Streaming chunk payload from ASSISTANT_STREAM events
 * Note: Worker sends DELTAS (not accumulated text) for efficiency
 */
export interface StreamChunkPayload {
  stream_id: string;
  delta: string;  // The new text chunk (delta, not accumulated)
  done: boolean;
  sequence: number;
  subAgentId?: string;  // For routing to browser panel's MessageList
}

/**
 * Plan streaming payload from PLAN_STREAM events
 * Ephemeral (not persisted to DB) - shows PlanChip with shimmer during LLM streaming
 */
export interface PlanStreamPayload {
  stream_id: string;
  tool_call_id: string;
  title: string;
}

/**
 * Attention message streaming payload from ATTENTION_STREAM events
 * Used for streaming send_message_to_user content progressively
 */
export interface AttentionStreamPayload {
  stream_id: string;
  tool_call_id: string;
  message: string;  // Accumulated message content (not delta)
  is_question: boolean;
  done: boolean;
  sequence: number;
}

/**
 * Tool streaming payload from TOOL_STREAM events
 * Ephemeral (not persisted to DB) - shows tool indicator during LLM streaming
 * before actual tool execution starts
 */
export interface ToolStreamPayload {
  stream_id: string;
  tool_call_id: string;
  tool_name: string;
  title: string;
}

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
  // Use getSession() to trigger auto-refresh if token is expired
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    await supabase.realtime.setAuth(session.access_token);
  } else {
    throw new Error('Not authenticated');
  }

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
 * Handlers for agent channel events
 */
export interface AgentHandlers {
  onInsert?: (payload: any) => void;
  onUpdate?: (payload: any) => void;
  onDelete?: (payload: any) => void;
  onAssistantStream?: (payload: StreamChunkPayload) => void;
  onPlanStream?: (payload: PlanStreamPayload) => void;
  onAttentionStream?: (payload: AttentionStreamPayload) => void;
  onToolStream?: (payload: ToolStreamPayload) => void;
  onAgentModeStarted?: () => void;
}

/**
 * Subscribe to a specific agent's channel
 * Receives broadcasts for messages and agent updates
 *
 * @param agentId - The agent ID to subscribe to
 * @param handlers - Callbacks for INSERT/UPDATE/DELETE events
 * @returns The realtime channel (call unsubscribe to clean up)
 */
export async function subscribeToAgent(
  agentId: string,
  handlers: AgentHandlers
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
  if (handlers.onAssistantStream) {
    eventHandlers['ASSISTANT_STREAM'] = (payload) => {
      const record = payload?.payload?.record;
      if (record) {
        handlers.onAssistantStream!({
          stream_id: record.stream_id,
          delta: record.delta,
          done: record.done,
          sequence: record.sequence,
          subAgentId: record.subAgentId,
        });
      }
    };
  }
  if (handlers.onPlanStream) {
    eventHandlers['PLAN_STREAM'] = (payload) => {
      const record = payload?.payload?.record;
      if (record) {
        handlers.onPlanStream!({
          stream_id: record.stream_id,
          tool_call_id: record.tool_call_id,
          title: record.title,
        });
      }
    };
  }
  if (handlers.onAttentionStream) {
    eventHandlers['ATTENTION_STREAM'] = (payload) => {
      const record = payload?.payload?.record;
      if (record) {
        handlers.onAttentionStream!({
          stream_id: record.stream_id,
          tool_call_id: record.tool_call_id,
          message: record.message,
          is_question: record.is_question,
          done: record.done,
          sequence: record.sequence,
        });
      }
    };
  }
  if (handlers.onToolStream) {
    eventHandlers['TOOL_STREAM'] = (payload) => {
      const record = payload?.payload?.record;
      if (record) {
        handlers.onToolStream!({
          stream_id: record.stream_id,
          tool_call_id: record.tool_call_id,
          tool_name: record.tool_name,
          title: record.title,
        });
      }
    };
  }
  if (handlers.onAgentModeStarted) {
    eventHandlers['AGENT_MODE_STARTED'] = () => {
      handlers.onAgentModeStarted!();
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
 * Handlers for bus channel events (sub-agent tree state)
 */
export interface BusHandlers {
  onAgentStateChanged?: (payload: any) => void;
}

/**
 * Subscribe to a bus channel for sub-agent tree state updates
 *
 * @param busId - The bus ID (typically root agent's ID)
 * @param handlers - Callbacks for AGENT_STATE_CHANGED events
 * @returns The realtime channel (call unsubscribe to clean up)
 */
export async function subscribeToBus(
  busId: string,
  handlers: BusHandlers
): Promise<RealtimeChannel> {
  const eventHandlers: EventHandlers = {};

  if (handlers.onAgentStateChanged) {
    eventHandlers['AGENT_STATE_CHANGED'] = handlers.onAgentStateChanged;
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
