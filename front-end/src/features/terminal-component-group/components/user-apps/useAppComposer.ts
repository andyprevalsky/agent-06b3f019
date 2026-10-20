/**
 * The query box floating over an app view.
 *
 * ROUTE (decided by the open view):
 *   view.taskId set (Rose, a trajectory task, or a user app whose row names the
 *   agent that last published it) → STEER: POST /api/claude-code-session/:taskId/turns
 *     (the existing code-agent steer path; one client_message_id per text so a
 *     retry of unchanged text never starts a second CLI turn) + local echo
 *   no task id (older user apps) → NEW AGENT: onStartAgent(goal), the normal
 *     POST /api/agents create; the app view stays open
 *
 * STATE: [IDLE] --submit non-empty--> [SENDING] --ok--> clear, exchange = {you, …}
 *                                               --error--> keep text, inline error
 * The latest exchange (you + the code agent's newest reply after it, or
 * "Started a new agent") shows just above the query box.
 */
import { useMemo, useRef, useState } from 'react';

import type { FilePointer } from '@/lib/api/types';

import { useAgentContext } from '../../hooks';
import {
  collectCodeAgentEvents,
  eventTimeMs,
  newDirectTurnId,
  sendCodeAgentMessage,
} from '../../hooks/codeAgentContract';
import { addLocalEcho, useLocalEchoes } from '../../hooks/codeAgentLocalState';
import type { OpenAppView } from './userAppsState';

export interface AppExchange {
  you: string;
  /** Newest reply of the steered code agent after the user's line (when visible). */
  reply: string | null;
  /** NEW AGENT route: the create succeeded. */
  startedAgent: boolean;
}

export interface AppComposer {
  value: string;
  setValue: (value: string) => void;
  sending: boolean;
  error: string | null;
  steers: boolean;
  submit: (attachments?: FilePointer[]) => void;
  exchange: AppExchange | null;
}

const NO_TASK = '';

function useSteerExchange(taskId: string | null): AppExchange | null {
  const echoes = useLocalEchoes(taskId ?? NO_TASK);
  const { messages } = useAgentContext();
  return useMemo(() => {
    const last = taskId === null ? undefined : echoes[echoes.length - 1];
    if (last === undefined || taskId === null) return null;
    const replies = collectCodeAgentEvents(messages, taskId).filter(
      (e) => e.type === 'message' && e.role !== 'user' && (eventTimeMs(e.ts) ?? 0) >= last.at,
    );
    const reply = replies[replies.length - 1]?.text ?? null;
    return { you: last.text, reply, startedAgent: false };
  }, [echoes, messages, taskId]);
}

export function useAppComposer(
  view: OpenAppView,
  onStartAgent: (goal: string, attachments?: FilePointer[]) => Promise<void>,
): AppComposer {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const turn = useRef<{ text: string; id: string } | null>(null);
  const steerExchange = useSteerExchange(view.taskId);
  const steers = view.taskId !== null;

  const send = async (text: string, attachments?: FilePointer[]) => {
    if (view.taskId === null) {
      await onStartAgent(text, attachments);
      setStarted(text);
      return;
    }
    if (turn.current?.text !== text) turn.current = { text, id: newDirectTurnId() };
    await sendCodeAgentMessage({ taskId: view.taskId, text, clientMessageId: turn.current.id });
    turn.current = null;
    addLocalEcho(view.taskId, text);
  };

  const submit = (attachments?: FilePointer[]) => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    send(text, attachments)
      .then(
        () => setValue(''),
        (err: unknown) => {
          const reason = err instanceof Error ? err.message : 'send failed';
          setError(
            steers
              ? `Couldn't reach ${view.title}: ${reason}`
              : `Couldn't start an agent: ${reason}`,
          );
        },
      )
      .finally(() => setSending(false));
  };

  const exchange = steers
    ? steerExchange
    : started !== null
      ? { you: started, reply: null, startedAgent: true }
      : null;
  return { value, setValue, sending, error, steers, submit, exchange };
}
