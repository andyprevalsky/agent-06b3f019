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
  codeAgentLabel,
  codeAgentToolCallId,
  collectCodeAgentEvents,
  latestCodeAgentMeta,
  messageRequester,
  parseCodeAgentMeta,
  parseDescendantPinnedQuestion,
  parsePinnedQuestion,
  type AttentionRequestLike,
  type CodeAgentMeta,
  type CodeAgentProvider,
  type CodeAgentTranscriptEvent,
  type PinnedQuestionDisplay,
  type RequestingAgent,
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

// ── Root status line under the chips (row 44) ───────────────────────────────

interface TaskRollup {
  provider: CodeAgentProvider;
  started: boolean;
  terminal: boolean;
  toolCallIds: Set<string>;
  meta: CodeAgentMeta | null;
}

const TERMINAL_ACTIONS = new Set(['task_complete', 'session_cancelled']);

/** Code tasks of the spawn tool, folded from their rows (later snapshots win). */
function rollupCodeTasks(messages: Message[]): Map<string, TaskRollup> {
  const tasks = new Map<string, TaskRollup>();
  const bareCancelCallIds = new Set<string>();
  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.toolName !== 'spawn_claude_code_agent') continue;
    const action: unknown = metadata.action_type;
    const callId = typeof metadata.toolCallId === 'string' ? metadata.toolCallId : null;
    const taskId = metadata.task_id;
    if (typeof taskId !== 'string' || taskId === '' || taskId === 'pending') {
      // Handler cancel can omit task_id; it still ends the task sharing its toolCallId.
      if (action === 'session_cancelled' && callId) bareCancelCallIds.add(callId);
      continue;
    }
    const task: TaskRollup = tasks.get(taskId) ?? {
      provider: 'claude',
      started: false,
      terminal: false,
      toolCallIds: new Set<string>(),
      meta: null,
    };
    if (metadata.code_provider === 'codex') task.provider = 'codex';
    if (action === 'claude_code_started') task.started = true;
    if (typeof action === 'string' && TERMINAL_ACTIONS.has(action)) task.terminal = true;
    if (callId) task.toolCallIds.add(callId);
    const meta = parseCodeAgentMeta(metadata.code_agent);
    if (meta && meta.task_id === taskId) task.meta = meta;
    tasks.set(taskId, task);
  }
  for (const task of tasks.values()) {
    if ([...task.toolCallIds].some((id) => bareCancelCallIds.has(id))) task.terminal = true;
  }
  return tasks;
}

function isLive(task: TaskRollup): boolean {
  if (task.terminal) return false;
  return task.meta ? task.meta.state === 'live' : task.started;
}

export type RootWaitStatus =
  | { kind: 'answer'; agent: string; base?: string }
  | { kind: 'one'; agent: string; branch?: string; base?: string }
  | { kind: 'many'; count: number };

/**
 * What the root agent is waiting on, derived from the trajectory alone:
 *   an open pinned question → "<agent> is waiting on your answer"
 *   one live code agent     → "Rose is waiting on <agent>[, then merges <branch> into <base>]"
 *   several live            → "Rose is waiting on <n> code agents"
 *   nothing live            → null (line hidden)
 */
export function deriveRootWaitStatus(
  messages: Message[],
  closedQuestions: ReadonlySet<string>,
): RootWaitStatus | null {
  const tasks = rollupCodeTasks(messages);
  const pending = findPendingQuestion(messages, closedQuestions);
  if (pending?.requester) {
    const taskId = pending.requester.task_id;
    const task = taskId ? tasks.get(taskId) : undefined;
    return { kind: 'answer', agent: pending.requester.label, base: task?.meta?.base_branch };
  }
  const live = [...tasks.values()].filter(isLive);
  if (live.length === 0) return null;
  if (live.length > 1) return { kind: 'many', count: live.length };
  const [task] = live;
  const provider = task.meta?.provider ?? task.provider;
  return {
    kind: 'one',
    agent: codeAgentLabel(provider),
    branch: task.meta?.branch || undefined,
    base: task.meta?.base_branch,
  };
}

export function useRootWaitStatus(): RootWaitStatus | null {
  const roseDesktop = useRoseDesktop();
  const { messages } = useAgentContext();
  const closed = useClosedQuestions();
  return useMemo(
    () => (roseDesktop ? deriveRootWaitStatus(messages, closed) : null),
    [closed, messages, roseDesktop],
  );
}
