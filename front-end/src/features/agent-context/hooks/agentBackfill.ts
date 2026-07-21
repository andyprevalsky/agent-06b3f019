import type React from 'react';
import type { AgentDetail, Message } from '@/lib/api';

import { fetchAgentDetail } from '../api';
import {
  BACKFILL_MAX_ATTEMPTS,
  BACKFILL_RETRY_BASE_MS,
  CONNECTED_COMPLETION_BACKFILL_MAX_ATTEMPTS,
  CONNECTED_COMPLETION_BACKFILL_POLL_MS,
  MAX_RECONNECT_DELAY_MS,
} from '../config';

/** Merge the authoritative API snapshot while retaining not-yet-persisted realtime messages. */
export function applyAgentBackfill(
  data: AgentDetail,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>,
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setMessages((previous) => {
    const apiIds = new Set(data.messages.map((message) => message.message_id));
    const realtimeOnly = previous.filter((message) => !apiIds.has(message.message_id));
    return [...data.messages, ...realtimeOnly].sort((left, right) =>
      (left.timestamp ?? '').localeCompare(right.timestamp ?? ''),
    );
  });
  setAgent(data.agent);
  setIsChatMode(!data.agent.temporal_workflow_id);
}

/** True while the latest chat turn has no canonical answer and has not entered agent mode. */
function latestChatTurnNeedsCompletionBackfill(data: AgentDetail): boolean {
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
    .some((message) => message.metadata?.isUserAttentionMessage === true);
}

interface PostSubscribeBackfillDeps {
  selectedAgentId: string;
  isCancelled: () => boolean;
  initialLoadDoneRef: React.MutableRefObject<string | null>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>;
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Reconcile after subscribing until the current turn completes. A connected
 * Supabase channel can still lose one broadcast, and broadcasts are not replayed.
 */
export async function runPostSubscribeBackfill({
  selectedAgentId,
  isCancelled,
  initialLoadDoneRef,
  setMessages,
  setAgent,
  setIsChatMode,
}: PostSubscribeBackfillDeps): Promise<void> {
  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < CONNECTED_COMPLETION_BACKFILL_MAX_ATTEMPTS; attempt += 1) {
    let retryDelayMs = CONNECTED_COMPLETION_BACKFILL_POLL_MS;
    try {
      const data = await fetchAgentDetail(selectedAgentId);
      if (isCancelled()) return;
      applyAgentBackfill(data, setMessages, setAgent, setIsChatMode);
      initialLoadDoneRef.current = selectedAgentId;
      consecutiveFailures = 0;
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
    if (attempt === CONNECTED_COMPLETION_BACKFILL_MAX_ATTEMPTS - 1) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    if (isCancelled()) return;
  }
}
