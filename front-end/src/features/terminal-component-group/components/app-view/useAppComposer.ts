/**
 * The query box floating over an app view: it talks to that view's code session.
 *
 *   submit → POST /api/claude-code-session/:taskId/turns (the existing code-agent
 *     steer path; one client_message_id per text so a retry of unchanged text
 *     never starts a second CLI turn) + local echo (the chip transcript shows it)
 *
 * STATE: [IDLE] --submit non-empty--> [SENDING] --ok--> clear, exchange = {you, reply}
 *                                               --error--> keep text, inline error
 * The latest exchange (your line + the code agent's newest reply after it, when
 * the open trajectory holds that session's events) shows just above the box.
 */
import { useMemo, useState } from 'react';
import type { FilePointer } from '@/lib/api/types';
import { useDirectTurn } from '../../hooks/codeAgentDirectTurn';

import { useAgentContext } from '../../hooks';
import { collectCodeAgentEvents, eventTimeMs } from '../../hooks/codeAgentContract';
import { getCodeDraft, setCodeDraft, useLocalEchoes } from '../../hooks/codeAgentLocalState';

export interface AppExchange {
  you: string;
  /** Newest reply of the steered code agent after the user's line (when visible). */
  reply: string | null;
}

export interface AppComposer {
  value: string;
  setValue: (value: string) => void;
  sending: boolean;
  error: string | null;
  submit: (attachments?: FilePointer[]) => Promise<boolean>;
  exchange: AppExchange | null;
}

function useExchange(taskId: string): AppExchange | null {
  const echoes = useLocalEchoes(taskId);
  const { messages } = useAgentContext();
  return useMemo(() => {
    const last = echoes[echoes.length - 1];
    if (last === undefined) return null;
    const replies = collectCodeAgentEvents(messages, taskId).filter(
      (e) => e.type === 'message' && e.role !== 'user' && (eventTimeMs(e.ts) ?? 0) >= last.at,
    );
    return { you: last.text, reply: replies[replies.length - 1]?.text ?? null };
  }, [echoes, messages, taskId]);
}

export function useAppComposer(taskId: string, label: string): AppComposer {
  const [value, setText] = useState(() => getCodeDraft(taskId)?.text ?? '');
  const { send, sending, error } = useDirectTurn(taskId);
  const exchange = useExchange(taskId);
  const setValue = (text: string) => {
    setText(text);
    setCodeDraft(taskId, { text, options: getCodeDraft(taskId)?.options ?? {} });
  };
  const submit = async (attachments?: FilePointer[]) => {
    const delivered = await send(value, {
      ...getCodeDraft(taskId)?.options,
      ...(attachments?.length ? { attachments } : {}),
    });
    if (delivered) setValue('');
    return delivered;
  };
  return {
    value,
    setValue,
    sending,
    error: error ? `Couldn't reach ${label}: ${error}` : null,
    submit,
    exchange,
  };
}
