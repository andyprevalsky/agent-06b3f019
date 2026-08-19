/**
 * i-message-queue-service — repo layer
 *
 * Data access: fetches the authenticated session, pops messages from the
 * backend queue, and dispatches a message to the AppleScript sender. Typed
 * args in, typed results out; no business logic.
 */

import Store from 'electron-store';
import { AuthService } from '../../services/auth';
import { IMessageSender } from '../../services/iMessageSender';
import { config } from '../../base/config';
import { sessionForLocalMachineData } from '../../base/impersonation';
import { DELIVERY_MARKER_STORE_NAME, QUEUE_POP_PATH, queueResultPath } from './config';
import type { DeliveryResultOutcome, PopOutcome, PopResponse, Session } from './types';

interface DeliveryMarkerSchema {
  sentQueueIds: Record<string, true>;
}

const deliveryMarkerStore = new Store<DeliveryMarkerSchema>({
  name: DELIVERY_MARKER_STORE_NAME,
  encryptionKey: config.encryptionKey,
  clearInvalidConfig: true,
});

export function hasSentQueueMarker(queueId: string): boolean {
  return deliveryMarkerStore.get('sentQueueIds', {})[queueId] === true;
}

export function markQueueMessageSent(queueId: string): void {
  deliveryMarkerStore.set('sentQueueIds', {
    ...deliveryMarkerStore.get('sentQueueIds', {}),
    [queueId]: true,
  });
}

export function clearSentQueueMarker(queueId: string): void {
  const markers = { ...deliveryMarkerStore.get('sentQueueIds', {}) };
  delete markers[queueId];
  deliveryMarkerStore.set('sentQueueIds', markers);
}

/**
 * Fetch the current authenticated session, if any.
 */
export async function getSession(): Promise<Session | null> {
  return sessionForLocalMachineData(await AuthService.getSession());
}

/**
 * Pop one message off the backend queue.
 */
export async function popQueuedMessage(accessToken: string): Promise<PopOutcome> {
  const response = await fetch(`${config.apiUrl}${QUEUE_POP_PATH}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-iMessage-Delivery-Results': 'v1',
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

/** Report the AppleScript send result so failed claims can be retried. */
export async function reportDeliveryResult(
  accessToken: string,
  queueId: string,
  result: { claim_token: string; success: boolean; error?: string }
): Promise<DeliveryResultOutcome> {
  const response = await fetch(`${config.apiUrl}${queueResultPath(queueId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(result),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, statusText: response.statusText };
  }
  return { ok: true };
}
