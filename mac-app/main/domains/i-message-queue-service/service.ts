/**
 * i-message-queue-service — service layer
 *
 * Business logic: drain the backend queue by repeatedly popping messages and
 * dispatching them to the AppleScript sender. Errors during send are logged
 * but swallowed — the message is already popped, so we continue the drain
 * instead of retrying.
 */

import { logConsole, logConsoleError } from '../../base/logger';
import { LOG_TAG } from './config';
import { getSession, popQueuedMessage, sendIMessage } from './repo';
import type { QueuedMessage } from './types';

/**
 * Mask a phone number for logs — shows the country-code prefix and hides the
 * rest to keep PII out of log files.
 */
function maskPhone(phoneNumber: string): string {
  return `${phoneNumber.substring(0, 4)}****`;
}

/**
 * Send a single queued message via AppleScript. Errors are logged and
 * swallowed — the message was already popped from the queue.
 */
async function sendOne(msg: QueuedMessage): Promise<void> {
  const maskedPhone = maskPhone(msg.phone_number);

  try {
    await sendIMessage(msg.phone_number, msg.message);
    logConsole(LOG_TAG, `Sent iMessage to ${maskedPhone}`);
  } catch (err) {
    logConsoleError(LOG_TAG, `Failed to send to ${maskedPhone}`, err);
  }
}

/**
 * Drain the backend queue: pop until the queue is empty or a pop fails.
 * Returns silently if the user is not authenticated.
 */
export async function drainQueue(): Promise<void> {
  const session = await getSession();
  if (!session) return;

  let hasMore = true;
  while (hasMore) {
    const outcome = await popQueuedMessage(session.access_token);

    if (!outcome.ok) {
      if (outcome.status !== 401) {
        logConsoleError(LOG_TAG, 'Pop request failed', outcome.statusText);
      }
      return;
    }

    if (!outcome.data.message) {
      hasMore = false;
      continue;
    }

    await sendOne(outcome.data.message);
  }
}
