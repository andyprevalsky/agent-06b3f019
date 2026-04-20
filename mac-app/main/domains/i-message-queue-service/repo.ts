/**
 * i-message-queue-service — repo layer
 *
 * Data access: fetches the authenticated session, pops messages from the
 * backend queue, and dispatches a message to the AppleScript sender. Typed
 * args in, typed results out; no business logic.
 */

import { AuthService } from '../../services/auth';
import { IMessageSender } from '../../services/iMessageSender';
import { config } from '../../base/config';
import { QUEUE_POP_PATH } from './config';
import type { PopOutcome, PopResponse, Session } from './types';

/**
 * Fetch the current authenticated session, if any.
 */
export async function getSession(): Promise<Session | null> {
  return AuthService.getSession();
}

/**
 * Pop one message off the backend queue.
 */
export async function popQueuedMessage(accessToken: string): Promise<PopOutcome> {
  const response = await fetch(`${config.apiUrl}${QUEUE_POP_PATH}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return { ok: false, status: response.status, statusText: response.statusText };
  }

  const data = (await response.json()) as PopResponse;
  return { ok: true, data };
}

/**
 * Send a message via the AppleScript iMessage bridge.
 */
export async function sendIMessage(to: string, message: string): Promise<void> {
  await IMessageSender.send({ to, message });
}
