/**
 * Derivations for the Rose Desktop code-agent steering UI (rows 44-47, 51).
 * Pure helpers + hooks over the agent's messages; the wire shapes they read
 * live in ./codeAgentContract.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { useAgentContext, type Message } from '../hooks';
import type { ChipState } from '../types';
import {
  answeredQuestionIds,
  codeAgentToolCallId,
  latestCodeAgentMeta,
  messageRequester,
  parseDescendantPinnedQuestion,
  parsePinnedQuestion,
  type AttentionRequestLike,
  type CodeAgentMeta,
  type CodeAgentTranscriptEvent,
  type PinnedQuestionDisplay,
  type RequestingAgent,
} from './codeAgentContract';
import { useClosedQuestions } from './codeAgentLocalState';
import { collectCodeAgentEvents } from './codeSessionTranscript';

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Wall clock that ticks every second while `running`. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return now;
}

/**
 * Lifecycle shown by the desktop chip. A terminal snapshot state (the
 * producer's completed / failed / paused, already folded over the task's rows)
 * wins: a paused session ends its spawn with an unsuccessful task_complete row
 * yet is resumable, and an explicit completed row is never re-read as failed.
 * While the snapshot still says running, the stock terminal reading (task row
 * or WS exit) wins over it.
 */
export function desktopChipState(meta: CodeAgentMeta, vmState: ChipState): ChipState {
  if (meta.state === 'completed' || meta.state === 'failed' || meta.state === 'paused') {
    return meta.state;
  }
  if (vmState === 'completed' || vmState === 'failed') return vmState;
  if (meta.state === 'live' && vmState === 'verifying') return 'verifying';
  return meta.state;
}

export interface DesktopCodeAgent {
  /** null → flag off or no `code_agent` snapshot: render the stock chip. */
  meta: CodeAgentMeta | null;
  events: CodeAgentTranscriptEvent[];
  /** The chip's spawn tool call, sent with direct turns. */
  toolCallId: string | undefined;
}

export function useDesktopCodeAgent(taskId: string, spawnToolCallId?: string): DesktopCodeAgent {
  const roseDesktop = useRoseDesktop();
  const { messages } = useAgentContext();
  const meta = useMemo(
    () => (roseDesktop ? latestCodeAgentMeta(messages, taskId, spawnToolCallId) : null),
    [messages, roseDesktop, spawnToolCallId, taskId],
  );
  const events = useMemo(
    () => (meta ? collectCodeAgentEvents(messages, taskId) : []),
    [meta, messages, taskId],
  );
  const toolCallId = useMemo(
    () => (meta ? codeAgentToolCallId(messages, taskId) : undefined),
    [messages, meta, taskId],
  );
  return { meta, events, toolCallId };
}

export interface PendingQuestion {
  question: PinnedQuestionDisplay;
  requester: RequestingAgent | null;
  /** Agent whose trajectory holds the pin (signs its media items). */
  ownerAgentId: string | null;
}

/**
 * Oldest pinned question of this trajectory that is still open (its row has not
 * finished) and was not closed in this session.
 */
export function findPendingQuestion(
  messages: Message[],
  closed: ReadonlySet<string>,
  ownerAgentId: string | null = null,
): PendingQuestion | null {
  const answered = answeredQuestionIds(messages);
  for (const message of messages) {
    const question = parsePinnedQuestion(message.metadata);
    if (!question) continue;
    if (answered.has(question.question_id) || closed.has(question.question_id)) continue;
    return { question, requester: messageRequester(message.metadata), ownerAgentId };
  }
  return null;
}

/**
 * Oldest open pin a DESCENDANT agent routed to `rootAgentId`, read from the
 * app-wide attention-request subscription (no extra channel or poll).
 */
export function findDescendantQuestion(
  requests: readonly AttentionRequestLike[],
  rootAgentId: string,
  closed: ReadonlySet<string>,
): PendingQuestion | null {
  for (const request of requests) {
    if (closed.has(request.id)) continue;
    const parsed = parseDescendantPinnedQuestion(request, rootAgentId);
    if (parsed) return { ...parsed, ownerAgentId: request.agent_id };
  }
  return null;
}

const NO_REQUESTS: readonly AttentionRequestLike[] = [];

/** The app-wide attention subscription, when mounted (absent in shared views). */
export interface AttentionSource {
  requests: readonly AttentionRequestLike[];
  refetch: () => Promise<void>;
}

export function usePendingQuestion(attention: AttentionSource | null): {
  pending: PendingQuestion | null;
  agentId: string | null;
  refetchAttention: () => void;
} {
  const roseDesktop = useRoseDesktop();
  const { messages, selectedAgentId, agent } = useAgentContext();
  const requests = attention?.requests ?? NO_REQUESTS;
  const closed = useClosedQuestions();
  const agentId = selectedAgentId ?? agent?.agent_id ?? null;
  const pending = useMemo(() => {
    if (!roseDesktop) return null;
    return (
      findPendingQuestion(messages, closed, agentId) ??
      (agentId ? findDescendantQuestion(requests, agentId, closed) : null)
    );
  }, [agentId, closed, messages, requests, roseDesktop]);
  const refetch = attention?.refetch;
  const refetchAttention = useCallback(() => {
    if (refetch) void refetch();
  }, [refetch]);
  return { pending, agentId, refetchAttention };
}
