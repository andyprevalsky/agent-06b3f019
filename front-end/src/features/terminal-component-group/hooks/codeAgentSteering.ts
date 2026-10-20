/**
 * Derivations for the Rose Desktop code-agent steering UI (rows 44-47, 51).
 * Pure helpers + hooks over the agent's messages; the wire shapes they read
 * live in ./codeAgentContract.ts.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { useAgentContext, type Message } from '../hooks';
import type { ChipState } from '../types';
import {
  answeredQuestionIds,
  collectCodeAgentEvents,
  latestCodeAgentMeta,
  parseCodeAgentSender,
  parsePinnedQuestion,
  type CodeAgentMeta,
  type CodeAgentSender,
  type CodeAgentTranscriptEvent,
  type PinnedQuestionDisplay,
} from './codeAgentContract';
import { useClosedQuestions } from './codeAgentLocalState';

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

/** Lifecycle shown by the desktop chip: a terminal task message outranks a stale snapshot. */
export function desktopChipState(meta: CodeAgentMeta, vmState: ChipState): ChipState {
  if (vmState === 'completed' || vmState === 'failed') return vmState;
  if (meta.state === 'live' && vmState === 'verifying') return 'verifying';
  return meta.state;
}

export interface DesktopCodeAgent {
  /** null → flag off or no `code_agent` snapshot: render the stock chip. */
  meta: CodeAgentMeta | null;
  events: CodeAgentTranscriptEvent[];
  agentId: string | null;
}

export function useDesktopCodeAgent(taskId: string): DesktopCodeAgent {
  const roseDesktop = useRoseDesktop();
  const { messages, selectedAgentId, agent } = useAgentContext();
  const meta = useMemo(
    () => (roseDesktop ? latestCodeAgentMeta(messages, taskId) : null),
    [messages, roseDesktop, taskId],
  );
  const events = useMemo(
    () => (meta ? collectCodeAgentEvents(messages, taskId) : []),
    [meta, messages, taskId],
  );
  return { meta, events, agentId: selectedAgentId ?? agent?.agent_id ?? null };
}

export interface PendingQuestion {
  question: PinnedQuestionDisplay;
  sender: CodeAgentSender | null;
}

/** Oldest pinned question not answered (durably) nor closed in this session. */
export function findPendingQuestion(
  messages: Message[],
  closed: ReadonlySet<string>,
): PendingQuestion | null {
  const answered = answeredQuestionIds(messages);
  for (const message of messages) {
    const question = parsePinnedQuestion(message.metadata);
    if (!question) continue;
    if (answered.has(question.question_id) || closed.has(question.question_id)) continue;
    return { question, sender: parseCodeAgentSender(message.metadata) };
  }
  return null;
}

export function usePendingQuestion(): { pending: PendingQuestion | null; agentId: string | null } {
  const roseDesktop = useRoseDesktop();
  const { messages, selectedAgentId, agent } = useAgentContext();
  const closed = useClosedQuestions();
  const pending = useMemo(
    () => (roseDesktop ? findPendingQuestion(messages, closed) : null),
    [closed, messages, roseDesktop],
  );
  return { pending, agentId: selectedAgentId ?? agent?.agent_id ?? null };
}
