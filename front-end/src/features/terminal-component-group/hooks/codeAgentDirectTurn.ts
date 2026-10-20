/**
 * One direct turn into a code agent's CLI session (POST
 * /api/claude-code-session/:taskId/turns), shared by the chip's steer input
 * and the code-agent view's query box.
 *
 * STATE MACHINE:
 *   [IDLE] --send(non-empty)--> [SENDING] --ok--> local "You → <agent>" echo → [IDLE] (true)
 *                                         --error--> error = the backend's message → [IDLE] (false)
 *   One client_message_id per text: retrying unchanged text reuses it (no second
 *   CLI turn); editing the text or a successful send starts a new one.
 */

import { useCallback, useRef, useState } from 'react';

import { sendCodeAgentMessage } from './codeAgentContract';
import { addLocalEcho } from './codeAgentLocalState';

/** A fresh idempotency key (`client_message_id`) for one direct turn. */
function newDirectTurnId(): string {
  return `turn-${crypto.randomUUID()}`;
}

export interface DirectTurn {
  /** Resolves true once delivered (the caller clears its input). */
  send: (text: string) => Promise<boolean>;
  sending: boolean;
  /** The backend's error text for the last failed send (e.g. a finished session's 409). */
  error: string | null;
}

export function useDirectTurn(taskId: string, toolCallId?: string): DirectTurn {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turn = useRef<{ text: string; id: string } | null>(null);
  const inFlight = useRef(false);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || inFlight.current) return false;
      if (turn.current?.text !== text) turn.current = { text, id: newDirectTurnId() };
      inFlight.current = true;
      setSending(true);
      setError(null);
      try {
        await sendCodeAgentMessage({ taskId, text, clientMessageId: turn.current.id, toolCallId });
        turn.current = null;
        addLocalEcho(taskId, text);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'send failed');
        return false;
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [taskId, toolCallId],
  );

  return { send, sending, error };
}
