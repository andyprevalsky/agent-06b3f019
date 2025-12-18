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
 * Handlers for agent channel events
 */
export interface AgentHandlers {
  onInsert?: (payload: any) => void;
  onUpdate?: (payload: any) => void;
  onDelete?: (payload: any) => void;
  onAssistantStream?: (payload: StreamChunkPayload) => void;
  onPlanStream?: (payload: PlanStreamPayload) => void;
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
  // Use getSession() to trigger auto-refresh if token is expired
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    await supabase.realtime.setAuth(session.access_token);
  } else {
    throw new Error('Not authenticated');
  }

  // Private channel - requires auth, worker uses service_role_key to broadcast
  const channel = supabase.channel(`agent:${agentId}`, {
    config: { private: true }
  });

  channel
    // Database triggers broadcast INSERT/UPDATE/DELETE events
    .on('broadcast', { event: 'INSERT' }, (payload) => {
      handlers?.onInsert?.(payload);
    })
    .on('broadcast', { event: 'UPDATE' }, (payload) => {
      handlers?.onUpdate?.(payload);
    })
    .on('broadcast', { event: 'DELETE' }, (payload) => {
      handlers?.onDelete?.(payload);
    })
    .on('broadcast', { event: 'ASSISTANT_STREAM' }, (payload) => {
      // Extract stream chunk data from payload
      const record = payload?.payload?.record;
      if (record && handlers?.onAssistantStream) {
        handlers.onAssistantStream({
          stream_id: record.stream_id,
          delta: record.delta,
          done: record.done,
          sequence: record.sequence,
        });
      }
    })
    .on('broadcast', { event: 'PLAN_STREAM' }, (payload) => {
      // Extract plan stream data from payload (ephemeral, no DB insert)
      const record = payload?.payload?.record;
      if (record && handlers?.onPlanStream) {
        handlers.onPlanStream({
          stream_id: record.stream_id,
          tool_call_id: record.tool_call_id,
          title: record.title,
        });
      }
    });

  return new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        resolve(channel);
      } else if (status === 'CHANNEL_ERROR') {
        console.error(`Failed to subscribe to agent:${agentId} - CHANNEL_ERROR`);
        reject(new Error(`Channel error for agent:${agentId}`));
      } else if (status === 'TIMED_OUT') {
        console.error(`Failed to subscribe to agent:${agentId} - TIMED_OUT`);
        reject(new Error(`Subscription timed out for agent:${agentId}`));
      } else if (status === 'CLOSED') {
        console.error(`Failed to subscribe to agent:${agentId} - CLOSED`);
        reject(new Error(`Channel closed for agent:${agentId}`));
      }
    });
  });
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
  // Use getSession() to trigger auto-refresh if token is expired
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    await supabase.realtime.setAuth(session.access_token);
  } else {
    throw new Error('Not authenticated');
  }

  const channel = supabase.channel(`user:${userId}`, {
    config: { private: true }
  });

  channel
    .on('broadcast', { event: 'INSERT' }, (payload) => {
      handlers?.onInsert?.(payload);
    })
    .on('broadcast', { event: 'UPDATE' }, (payload) => {
      handlers?.onUpdate?.(payload);
    })
    .on('broadcast', { event: 'DELETE' }, (payload) => {
      handlers?.onDelete?.(payload);
    });

  return new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        resolve(channel);
      } else if (status === 'CHANNEL_ERROR') {
        console.error(`Failed to subscribe to user:${userId} attention requests - CHANNEL_ERROR`);
        reject(new Error(`Channel error for user:${userId}`));
      } else if (status === 'TIMED_OUT') {
        console.error(`Failed to subscribe to user:${userId} attention requests - TIMED_OUT`);
        reject(new Error(`Subscription timed out for user:${userId}`));
      } else if (status === 'CLOSED') {
        console.error(`Failed to subscribe to user:${userId} attention requests - CLOSED`);
        reject(new Error(`Channel closed for user:${userId}`));
      }
    });
  });
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

