/**
 * i-message-queue-service — service layer
 *
 * Business logic: claim backend queue items, dispatch them to the AppleScript
 * sender, and acknowledge each result. Failed sends are released by the
 * backend for a bounded retry instead of being lost.
 */

import { logConsole, logConsoleError } from '../../base/logger';
import { getErrorMessage } from '../../../shared/utils/error';
import { LOG_TAG } from './config';
import {
  clearSentQueueMarker,
  getSession,
  hasSentQueueMarker,
  markQueueMessageSent,
  popQueuedMessage,
  reportDeliveryResult,
  sendIMessage,
} from './repo';
import type { QueuedMessage } from './types';

/**
 * Mask a phone number for logs — shows the country-code prefix and hides the
 * rest to keep PII out of log files.
 */
function maskPhone(phoneNumber: string): string {
  return `${phoneNumber.substring(0, 4)}****`;
}

/**
 * Send a claimed message and report the result to the durable queue.
 */
async function sendOne(accessToken: string, msg: QueuedMessage): Promise<void> {
  const maskedPhone = maskPhone(msg.phone_number);

  if (!hasSentQueueMarker(msg.id)) {
    try {
      await sendIMessage(msg.phone_number, msg.message);
      // Persist before the backend ACK. If ACK is lost, the next lease only
      // retries the acknowledgement and never runs AppleScript a second time.
      markQueueMessageSent(msg.id);
    } catch (err) {
      const error = getErrorMessage(err);
      const outcome = await reportDeliveryResult(accessToken, msg.id, {
        claim_token: msg.claim_token,
        success: false,
        error,
      });
      if (!outcome.ok) {
        logConsoleError(
          LOG_TAG,
          `Failed to report send failure for ${maskedPhone}`,
          outcome.statusText
        );
      }
      logConsoleError(LOG_TAG, `Failed to send to ${maskedPhone}`, err);
      return;
    }
  }

  const outcome = await reportDeliveryResult(accessToken, msg.id, {
    claim_token: msg.claim_token,
    success: true,
  });
  if (!outcome.ok) {
    logConsoleError(LOG_TAG, `Sent but failed to acknowledge ${maskedPhone}`, outcome.statusText);
    return;
  }
  clearSentQueueMarker(msg.id);
  logConsole(LOG_TAG, `Sent iMessage to ${maskedPhone}`);
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

    await sendOne(session.access_token, outcome.data.message);
  }
}
