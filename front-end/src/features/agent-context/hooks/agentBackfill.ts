import type React from 'react';
import { replaceEqualDeep } from '@tanstack/react-query';
import type { AgentDetail, AgentDetailResponse, Message } from '@/lib/api';
import type { InsertMessagePayload } from '@/lib/realtime';

import { computeActiveBrowserPanels } from '@/lib/browserPanelLifecycle';

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
    return replaceEqualDeep(
      previous,
      [...data.messages, ...realtimeOnly].sort((left, right) =>
        (left.timestamp ?? '').localeCompare(right.timestamp ?? ''),
      ),
    );
  });
  setAgent((previous) => (isCurrentAgent() ? replaceEqualDeep(previous, data.agent) : previous));
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
  browserTaskIds?: Set<string>;
}

/** Grant one finite recovery window per newly observed browser lifecycle. */
export function registerBrowserBackfillTask(
  leaseRef: React.MutableRefObject<CompletionBackfillLease | null>,
  agentId: string,
  taskId: string,
): boolean {
  if (leaseRef.current?.agentId !== agentId) {
    leaseRef.current = {
      agentId,
      turnId: null,
      expiresAt: Date.now() + CONNECTED_COMPLETION_BACKFILL_WINDOW_MS,
    };
  }
  const lease = leaseRef.current;
  lease.browserTaskIds ??= new Set();
  if (lease.browserTaskIds.has(taskId)) return false;
  lease.browserTaskIds.add(taskId);
  lease.expiresAt = Date.now() + CONNECTED_COMPLETION_BACKFILL_WINDOW_MS;
  return true;
}

/** A stalled read must release its owner even if the transport ignores abort. */
async function fetchCompletionSnapshot(agentId: string, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Connected backfill request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchAgentDetail(agentId, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** Release both the retry timer and its captured trajectory when its owner exits. */
function waitForBackfill(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

interface PostSubscribeBackfillDeps {
  observedMessages?: () => Message[];
  selectedAgentId: string;
  isCancelled: () => boolean;
  isCurrentAgent: () => boolean;
  leaseRef: React.MutableRefObject<CompletionBackfillLease | null>;
  initialLoadDoneRef: React.MutableRefObject<string | null>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>;
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>;
  signal?: AbortSignal;
}

/**
 * Reconcile a pending selected turn within a finite recovery window. A connected
 * Supabase channel can still lose one broadcast, and broadcasts are not replayed.
 */
export async function runPostSubscribeBackfill({
  selectedAgentId,
  observedMessages = () => [],
  isCancelled,
  isCurrentAgent,
  leaseRef,
  initialLoadDoneRef,
  setMessages,
  setAgent,
  setIsChatMode,
  signal,
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
        signal,
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
      // An INSERT can arrive before its snapshot is visible. Preserve those
      // observations when deciding whether recovery has finished, just as the
      // message setter preserves realtime-only messages during hydration.
      const messagesById = new Map(
        observedMessages().map((message) => [message.message_id, message]),
      );
      data.messages.forEach((message) => messagesById.set(message.message_id, message));
      const activeBrowsers = computeActiveBrowserPanels([...messagesById.values()]);
      for (const { taskId } of activeBrowsers) {
        registerBrowserBackfillTask(leaseRef, selectedAgentId, taskId);
      }
      if (!latestChatTurnNeedsCompletionBackfill(data) && activeBrowsers.length === 0) break;
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
    await waitForBackfill(delayMs, signal);
    if (isCancelled()) return;
  }
}

/** Subscription and browser lifecycle events share one scoped read owner. */
export function createCompletionBackfillOwner(
  deps: Omit<PostSubscribeBackfillDeps, 'observedMessages'>,
  observedBrowserMessages: Map<string, Message>,
) {
  let recovering = false;
  let requested = false;
  const reconcile = async () => {
    requested = true;
    if (recovering || deps.isCancelled() || !deps.isCurrentAgent()) return;
    recovering = true;
    try {
      // A new init can arrive as the previous loop is returning. Retain its
      // demand across that await boundary without creating a second reader.
      do {
        requested = false;
        await runPostSubscribeBackfill({
          ...deps,
          observedMessages: () => [...observedBrowserMessages.values()],
        });
      } while (requested && !deps.isCancelled() && deps.isCurrentAgent());
    } finally {
      recovering = false;
    }
  };
  const observeBrowserInsert = (data: InsertMessagePayload) => {
    const message: Message = {
      message_id: data.id,
      timestamp: data.timestamp,
      text: data.text,
      role: data.role,
      metadata: data.metadata ?? undefined,
    };
    observedBrowserMessages.set(message.message_id, message);
    const task = computeActiveBrowserPanels([message])[0];
    // Only a new init grants a window; duplicates/progress cannot renew it.
    if (task && registerBrowserBackfillTask(deps.leaseRef, deps.selectedAgentId, task.taskId)) {
      void reconcile();
    }
  };
  return { reconcile, observeBrowserInsert };
}
