import type React from 'react';
import type { AgentDetail, AgentDetailResponse, Message } from '@/lib/api';

import { fetchAgentDetail } from '../api';
import { isChatCapableAgent } from './realtimeHandlers';
import {
  BACKFILL_MAX_ATTEMPTS,
  BACKFILL_RETRY_BASE_MS,
  CONNECTED_COMPLETION_BACKFILL_FAST_ATTEMPTS,
  CONNECTED_COMPLETION_BACKFILL_POLL_MS,
  CONNECTED_COMPLETION_BACKFILL_WINDOW_MS,
  DISCONNECTED_BACKFILL_POLL_MS,
  DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS,
  MAX_RECONNECT_DELAY_MS,
} from '../config';

/** Merge the authoritative API snapshot while retaining not-yet-persisted realtime messages. */
export function applyAgentBackfill(
  data: AgentDetailResponse,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>,
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>,
  isCurrentAgent: () => boolean = () => true,
): void {
  if (!isCurrentAgent()) return;
  setMessages((previous) => {
    if (!isCurrentAgent()) return previous;
    const apiIds = new Set(data.messages.map((message) => message.message_id));
    const realtimeOnly = previous.filter((message) => !apiIds.has(message.message_id));
    return [...data.messages, ...realtimeOnly].sort((left, right) =>
      (left.timestamp ?? '').localeCompare(right.timestamp ?? ''),
    );
  });
  setAgent((previous) => (isCurrentAgent() ? data.agent : previous));
  setIsChatMode((previous) => (isCurrentAgent() ? isChatCapableAgent(data.agent) : previous));
}

/** True while the latest chat turn has no canonical answer and has not entered agent mode. */
function latestChatTurnNeedsCompletionBackfill(data: AgentDetailResponse): boolean {
  if (data.agent.temporal_workflow_id) return false;
  let latestUserIndex = -1;
  for (let index = data.messages.length - 1; index >= 0; index -= 1) {
    if (data.messages[index]?.role === 'USER') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex === -1) return false;
  return !data.messages
    .slice(latestUserIndex + 1)
    .some(
      (message) =>
        message.metadata?.isUserAttentionMessage === true ||
        (message.role === 'ASSISTANT' &&
          message.metadata?.error === true &&
          message.metadata?.source === 'chat_handler_failure'),
    );
}

export interface CompletionBackfillLease {
  agentId: string;
  turnId: string | null;
  expiresAt: number;
}

/** A stalled read must release its owner even if the transport ignores abort. */
async function fetchCompletionSnapshot(agentId: string, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Connected backfill request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchAgentDetail(agentId, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface PostSubscribeBackfillDeps {
  selectedAgentId: string;
  isCancelled: () => boolean;
  isCurrentAgent: () => boolean;
  leaseRef: React.MutableRefObject<CompletionBackfillLease | null>;
  initialLoadDoneRef: React.MutableRefObject<string | null>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>;
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Reconcile a pending selected turn within a finite recovery window. A connected
 * Supabase channel can still lose one broadcast, and broadcasts are not replayed.
 */
export async function runPostSubscribeBackfill({
  selectedAgentId,
  isCancelled,
  isCurrentAgent,
  leaseRef,
  initialLoadDoneRef,
  setMessages,
  setAgent,
  setIsChatMode,
}: PostSubscribeBackfillDeps): Promise<void> {
  if (leaseRef.current?.agentId !== selectedAgentId) {
    leaseRef.current = {
      agentId: selectedAgentId,
      turnId: null,
      expiresAt: Date.now() + CONNECTED_COMPLETION_BACKFILL_WINDOW_MS,
    };
  }
  const lease = leaseRef.current;
  let consecutiveFailures = 0;
  for (let attempt = 0; !isCancelled() && isCurrentAgent(); attempt += 1) {
    const remainingMs = lease.expiresAt - Date.now();
    // Reconnects still get their cold-start snapshot, but cannot renew a pending turn's lease.
    if (attempt > 0 && remainingMs <= 0) break;
    let retryDelayMs =
      attempt < CONNECTED_COMPLETION_BACKFILL_FAST_ATTEMPTS
        ? CONNECTED_COMPLETION_BACKFILL_POLL_MS
        : DISCONNECTED_BACKFILL_POLL_MS;
    try {
      const data = await fetchCompletionSnapshot(
        selectedAgentId,
        Math.min(
          DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS,
          attempt === 0 ? DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS : remainingMs,
        ),
      );
      if (isCancelled() || !isCurrentAgent()) return;
      applyAgentBackfill(data, setMessages, setAgent, setIsChatMode, isCurrentAgent);
      if (!isCurrentAgent()) return;
      initialLoadDoneRef.current = selectedAgentId;
      consecutiveFailures = 0;
      const turnId = [...data.messages]
        .reverse()
        .find((message) => message.role === 'USER')?.message_id;
      if (turnId && lease.turnId !== turnId) {
        lease.expiresAt = Date.now() + CONNECTED_COMPLETION_BACKFILL_WINDOW_MS;
        lease.turnId = turnId;
      }
      if (!latestChatTurnNeedsCompletionBackfill(data)) break;
    } catch (error) {
      if (isCancelled()) return;
      consecutiveFailures += 1;
      console.error(
        `Failed to backfill after subscribe (failure ${consecutiveFailures}/${BACKFILL_MAX_ATTEMPTS}):`,
        error,
      );
      if (consecutiveFailures >= BACKFILL_MAX_ATTEMPTS) break;
      retryDelayMs = Math.min(
        BACKFILL_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1),
        MAX_RECONNECT_DELAY_MS,
      );
    }
    const delayMs = Math.min(retryDelayMs, lease.expiresAt - Date.now());
    if (delayMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (isCancelled()) return;
  }
}
