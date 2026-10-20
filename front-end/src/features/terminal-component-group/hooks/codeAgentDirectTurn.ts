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

import { sendCodeAgentMessage, type CodeTurnOptions } from './codeAgentContract';
import { addLocalEcho, pendingCodeTurns } from './codeAgentLocalState';

/** A fresh idempotency key (`client_message_id`) for one direct turn. */
function newDirectTurnId(): string {
  return `turn-${crypto.randomUUID()}`;
}

export interface DirectTurn {
  /** Resolves true once delivered (the caller clears its input). */
  send: (text: string, options?: CodeTurnOptions) => Promise<boolean>;
  effective: CodeTurnOptions | null;
  sending: boolean;
  /** The backend's error text for the last failed send (e.g. a finished session's 409). */
  error: string | null;
}

export function useDirectTurn(taskId: string, toolCallId?: string): DirectTurn {
  const [effective, setEffective] = useState<CodeTurnOptions | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const send = useCallback(
    async (raw: string, options?: CodeTurnOptions) => {
      const text = raw.trim();
      if ((!text && !options?.attachments?.length) || inFlight.current) return false;
      const payload = JSON.stringify({ text, ...options });
      if (pendingCodeTurns.get(taskId)?.payload !== payload)
        pendingCodeTurns.set(taskId, { payload, id: newDirectTurnId() });
      inFlight.current = true;
      setSending(true);
      setError(null);
      try {
        const id = pendingCodeTurns.get(taskId)!.id;
        const ack = await sendCodeAgentMessage({
          taskId,
          text,
          clientMessageId: id,
          toolCallId,
          options,
        });
        setEffective(
          ack.effective_settings
            ? {
                model: ack.effective_settings.model,
                reasoning_effort: ack.effective_settings.effort,
                speed: ack.effective_settings.speed,
              }
            : null,
        );
        pendingCodeTurns.delete(taskId);
        addLocalEcho(taskId, text, Date.now(), id);
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

  return { send, sending, error, effective };
}
