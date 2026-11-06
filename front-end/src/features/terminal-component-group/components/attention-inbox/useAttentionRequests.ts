/**
 * Data-loading + realtime hook for the AttentionInbox.
 *
 * Owns the `requests` list, the initial fetch, a 10s polling fallback (backend
 * does not broadcast to Supabase), and the realtime subscription that keeps
 * the list in sync via INSERT/UPDATE/DELETE events on the user channel. Also
 * exposes `refetch` for imperative refresh after an action.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  getAttentionRequests,
  getStoredSession,
  subscribeToAttentionRequests,
  unsubscribe,
} from '../../hooks';
import { supabase } from '@/lib/supabase';
import { isSubscriptionAbort } from '@/lib/realtime';
import type { AttentionRequest } from './types';

const POLL_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

interface InsertRecord {
  id: string;
  agentId: string;
  workflowId: string;
  question: string;
  imageUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  userResponse?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WrappedPayload {
  record?: InsertRecord;
  payload?: { record?: InsertRecord };
}

function extractRecord(payload: unknown): InsertRecord | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const wrapper = payload as WrappedPayload;
  return wrapper.record ?? wrapper.payload?.record;
}

function recordToRequest(data: InsertRecord): AttentionRequest {
  return {
    id: data.id,
    agent_id: data.agentId,
    workflow_id: data.workflowId,
    question: data.question,
    image_url: data.imageUrl,
    metadata: data.metadata,
    user_response: data.userResponse,
    created_at: data.createdAt,
    updated_at: data.updatedAt,
    answered: !!data.userResponse,
  };
}

function buildSubscriptionHandlers(
  setRequests: Dispatch<SetStateAction<AttentionRequest[]>>,
  scheduleReconnect: () => void,
  isCancelled: () => boolean,
) {
  return {
    onInsert: (payload: unknown) => {
      const data = extractRecord(payload);
      if (!data) return;
      setRequests((prev) => [...prev, recordToRequest(data)]);
    },
    onUpdate: (payload: unknown) => {
      const data = extractRecord(payload);
      if (!data) return;
      setRequests((prev) =>
        prev.map((req) =>
          req.id === data.id
            ? {
                ...req,
                user_response: data.userResponse,
                updated_at: data.updatedAt,
                metadata: data.metadata ?? req.metadata,
                answered: !!data.userResponse,
              }
            : req,
        ),
      );
    },
    onDelete: (payload: unknown) => {
      const data = extractRecord(payload);
      if (!data) return;
      setRequests((prev) => prev.filter((req) => req.id !== data.id));
    },
    onDisconnect: () => {
      // Our own unsubscribe on cleanup also surfaces as CLOSED; not a disconnect.
      if (isCancelled()) return;
      console.warn('[AttentionInbox] Channel disconnected, scheduling reconnect');
      scheduleReconnect();
    },
  };
}

export interface UseAttentionRequestsResult {
  requests: AttentionRequest[];
  refetch: () => Promise<void>;
}

/** Count of unanswered requests — drives the notification badge trail. */
export function unansweredCount(requests: AttentionRequest[]): number {
  return requests.filter((r) => !r.answered).length;
}

export function useAttentionRequests(realtimeReady: boolean): UseAttentionRequestsResult {
  const [requests, setRequests] = useState<AttentionRequest[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const [forceResubscribe, setForceResubscribe] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const fresh = await getAttentionRequests();
      setRequests(fresh);
    } catch (error) {
      console.error('Failed to fetch attention requests:', error);
    }
  }, []);

  // Initial fetch + polling fallback
  useEffect(() => {
    void refetch();
    const pollInterval = setInterval(() => {
      void refetch();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(pollInterval);
  }, [refetch]);

  // Realtime subscription (wired once auth is ready)
  useEffect(() => {
    if (!realtimeReady) return;

    let cancelled = false;

    const scheduleReconnect = () => {
      // Bail before scheduling if the hook already cleaned up or jsdom tore
      // down `window` — otherwise setup().catch can create a timer after unmount
      // that no later cleanup can clear.
      if (cancelled || typeof window === 'undefined') return;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt),
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectAttemptRef.current += 1;
      reconnectTimeoutRef.current = window.setTimeout(() => {
        // Keep the callback guard for timers that were already scheduled.
        if (cancelled || typeof window === 'undefined') return;
        setForceResubscribe((prev) => prev + 1);
      }, delay);
    };

    // Cancels a join still pending at teardown (channelRef is only set once SUBSCRIBED).
    const pendingJoin = new AbortController();

    const setup = async () => {
      const session = getStoredSession();
      const userId = session?.user?.id;
      if (!userId) return;

      if (channelRef.current) {
        await supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      try {
        const channel = await subscribeToAttentionRequests(userId, {
          ...buildSubscriptionHandlers(setRequests, scheduleReconnect, () => cancelled),
          signal: pendingJoin.signal,
        });
        if (cancelled) {
          await supabase.removeChannel(channel);
          return;
        }
        channelRef.current = channel;
        reconnectAttemptRef.current = 0;
        await refetch();
      } catch (error) {
        // Our own cancellation: the channel is already gone, nothing to retry.
        if (cancelled && isSubscriptionAbort(error)) return;
        console.error('Failed to subscribe to attention requests:', error);
        scheduleReconnect();
      }
    };

    void setup();

    return () => {
      cancelled = true;
      pendingJoin.abort();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      unsubscribe(channelRef.current);
      channelRef.current = null;
    };
  }, [forceResubscribe, realtimeReady, refetch]);

  return { requests, refetch };
}
