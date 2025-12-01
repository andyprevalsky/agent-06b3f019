import { supabase, getStoredSession } from './supabase';
import { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Handlers for agent channel events
 */
export interface AgentHandlers {
  onInsert?: (payload: any) => void;
  onUpdate?: (payload: any) => void;
  onDelete?: (payload: any) => void;
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
  // Ensure realtime has auth token
  const session = getStoredSession();
  if (session?.access_token) {
    await supabase.realtime.setAuth(session.access_token);
  } else {
    throw new Error('Not authenticated');
  }

  const channel = supabase.channel(`agent:${agentId}`, {
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
  // Ensure realtime has auth token
  const session = getStoredSession();
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

