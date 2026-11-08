/**
 * A stopped code agent resumed by the person's message (backend
 * directChatResume.ts): the owner starts the spawn's next run under the SAME
 * spawn tool call, with a new task id; the CLI continues its own conversation.
 *
 * mergeCodeAgentRuns: the code-agent view shows every run of one spawn as one
 *   conversation — rows of the spawn's other runs read as the open task's rows
 *   (metadata.task_id rewritten; `run_task_id` keeps the original).
 *
 * codeAgentResumeState: the state next to a resuming message's timestamp, from
 *   the spawn's own rows after it (never a timer or text guess):
 *
 *   user_direct_turn {resume_requested} at T
 *     no spawn row after T ─────────────────────────▶ resuming  "Resuming…"
 *     a spawn row after T (next run started) ───────▶ starting  "Starting container…"
 *     claude_code_started after T (CLI has the turn) ▶ delivered "Delivered"
 *     ERROR / failed task_complete after T, before started
 *                                                  ─▶ failed    "Couldn't resume: <text>"
 */
import type { Message } from '@/lib/api/types';

import { eventTimeMs } from './codeAgentContract';

const SPAWN_TOOL = 'spawn_claude_code_agent';

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The spawn tool call of a code task (its rows carry it). */
function spawnToolCallId(messages: Message[], taskId: string): string | null {
  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.task_id === taskId && metadata.toolName === SPAWN_TOOL) {
      const id = str(metadata.toolCallId);
      if (id) return id;
    }
  }
  return null;
}

export interface CodeAgentRuns {
  /** The owner's messages with the spawn's other runs read as `taskId`. */
  messages: Message[];
  /** The newest run's task id (the open one when it never resumed). */
  latestTaskId: string;
}

export function mergeCodeAgentRuns(messages: Message[], taskId: string): CodeAgentRuns {
  const toolCallId = spawnToolCallId(messages, taskId);
  if (toolCallId === null) return { messages, latestTaskId: taskId };
  const runs = new Set<string>();
  let latestTaskId = taskId;
  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.toolName !== SPAWN_TOOL || metadata.toolCallId !== toolCallId) continue;
    // The person's own turn rows name the task they were typed to, not a run.
    if ((metadata.action_type as string) === 'user_direct_turn') continue;
    const runTask = str(metadata.task_id);
    if (runTask === null || runTask === 'pending') continue;
    latestTaskId = runTask;
    if (runTask !== taskId) runs.add(runTask);
  }
  if (runs.size === 0) return { messages, latestTaskId: taskId };
  return {
    latestTaskId,
    messages: messages.map((message) => {
      const runTask = str(message.metadata?.task_id);
      if (runTask === null || !runs.has(runTask)) return message;
      return {
        ...message,
        metadata: { ...message.metadata, task_id: taskId, run_task_id: runTask },
      };
    }),
  };
}

export type CodeAgentResumeStatus = 'resuming' | 'starting' | 'delivered' | 'failed';

export interface CodeAgentResumeState {
  status: CodeAgentResumeStatus;
  /** The failure text for `failed`. */
  detail?: string;
  /** What comes back online: a code agent's container (default) or a browser. */
  subject?: 'container' | 'browser';
}

export function codeAgentResumeLabel(state: CodeAgentResumeState): string {
  if (state.status === 'resuming') return 'Resuming…';
  if (state.status === 'starting')
    return state.subject === 'browser' ? 'Starting browser…' : 'Starting container…';
  if (state.status === 'delivered') return 'Delivered';
  return `Couldn't resume${state.detail ? `: ${state.detail}` : ''}`;
}

/** The resume state of a person's message that asked a stopped code agent to resume; null otherwise. */
export function codeAgentResumeState(
  messages: Message[],
  row: Message,
): CodeAgentResumeState | null {
  const metadata = row.metadata;
  if (metadata?.resume_requested !== true) return null;
  const toolCallId = str(metadata.toolCallId);
  const at = eventTimeMs(row.timestamp);
  if (toolCallId === null || at === null) return { status: 'resuming' };
  let state: CodeAgentResumeState = { status: 'resuming' };
  const later = messages
    .filter((message) => {
      const time = eventTimeMs(message.timestamp);
      return (
        message.message_id !== row.message_id &&
        message.metadata?.toolCallId === toolCallId &&
        (message.metadata?.action_type as string) !== 'user_direct_turn' &&
        time !== null &&
        time >= at
      );
    })
    .sort((a, b) => (eventTimeMs(a.timestamp) ?? 0) - (eventTimeMs(b.timestamp) ?? 0));
  for (const message of later) {
    const m = message.metadata ?? {};
    if (m.action_type === 'claude_code_started') return { status: 'delivered' };
    const failed =
      m.toolStatus === 'ERROR' || (m.action_type === 'task_complete' && m.success === false);
    if (failed) state = { status: 'failed', detail: message.text.trim() || undefined };
    else if (state.status === 'resuming') state = { status: 'starting' };
  }
  return state;
}

/**
 * The view's rows with each resuming person message annotated
 * (metadata.codeAgentResume, read by UserBubble). The resumed run's CLI gets the
 * person's text as its next turn and records it again: that later copy (as a
 * user row or a Rose → code agent row) never renders twice.
 */
export function withResumeStates(source: Message[], taskId: string, rows: Message[]): Message[] {
  const states = new Map<string, CodeAgentResumeState>();
  for (const message of source) {
    const metadata = message.metadata;
    if (metadata?.task_id !== taskId) continue;
    if ((metadata.action_type as string) !== 'user_direct_turn') continue;
    const turnId = str(metadata.direct_turn_id);
    const state = codeAgentResumeState(source, message);
    if (turnId && state) states.set(`code:${taskId}:turn:${turnId}`, state);
  }
  if (states.size === 0) return rows;
  const resumed: Array<{ text: string; at: number }> = [];
  const out: Message[] = [];
  for (const row of rows) {
    const state = row.role === 'USER' ? states.get(row.message_id) : undefined;
    if (state) {
      resumed.push({ text: row.text, at: eventTimeMs(row.timestamp) ?? 0 });
      out.push({ ...row, metadata: { ...row.metadata, codeAgentResume: state } });
      continue;
    }
    const a2a = row.metadata?.a2a as { text?: unknown } | undefined;
    const text = row.role === 'USER' ? row.text : str(a2a?.text);
    const at = eventTimeMs(row.timestamp) ?? 0;
    if (text && resumed.some((person) => person.text === text && at >= person.at)) continue;
    out.push(row);
  }
  return out;
}

function rowsAfter(messages: Message[], row: Message): Message[] {
  const at = eventTimeMs(row.timestamp) ?? 0;
  return messages
    .filter(
      (message) =>
        message.message_id !== row.message_id && (eventTimeMs(message.timestamp) ?? 0) >= at,
    )
    .sort((a, b) => (eventTimeMs(a.timestamp) ?? 0) - (eventTimeMs(b.timestamp) ?? 0));
}

/**
 * A person's message that resumed a stopped Rose agent (backend `resumedFrom`):
 * Resuming… until the agent's next row (its reply or work), then Delivered.
 */
export function roseResumeState(messages: Message[], row: Message): CodeAgentResumeState | null {
  if (typeof row.metadata?.resumedFrom !== 'string') return null;
  const replied = rowsAfter(messages, row).some((message) => message.role !== 'USER');
  return { status: replied ? 'delivered' : 'resuming' };
}

/**
 * A Browser-composer message that resumed a paused browser (backend
 * `browserResume`, the spawn's `toolCallId`), from that browser's rows after it:
 * none → Resuming… · the resumed run's first row → Starting browser… · a later
 * row (it stepped) → Delivered · an ERROR row first → Couldn't resume: <reason>.
 */
export function browserResumeState(messages: Message[], row: Message): CodeAgentResumeState | null {
  const toolCallId = row.metadata?.browserResume === true ? str(row.metadata.toolCallId) : null;
  if (toolCallId === null) return null;
  const own = rowsAfter(messages, row).filter((message) => {
    const id = str(message.metadata?.toolCallId);
    return (
      message.role !== 'USER' &&
      id !== null &&
      (id === toolCallId || id.startsWith(`${toolCallId}:`))
    );
  });
  const failure = own.find((message) => message.metadata?.toolStatus === 'ERROR');
  if (failure && own.indexOf(failure) <= 1) {
    return { status: 'failed', detail: failure.text.trim() || undefined, subject: 'browser' };
  }
  if (own.length === 0) return { status: 'resuming', subject: 'browser' };
  return { status: own.length === 1 ? 'starting' : 'delivered', subject: 'browser' };
}
