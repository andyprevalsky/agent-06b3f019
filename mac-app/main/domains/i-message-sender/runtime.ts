/**
 * i-message-sender — runtime layer
 *
 * Thin public entry for the AppleScript iMessage bridge. Exposes the static
 * {@link IMessageSender} class, which the i-message-queue-service repo (and
 * the blackbox suite) already depend on. Delegates to the service layer — no
 * raw data access, no inline business logic.
 *
 * Layer rule: runtime imports own service + own types only.
 */

import { sendIMessage } from './service';
import type { IMessagePayload } from './types';

export type { IMessagePayload } from './types';

/**
 * Sends iMessages via the macOS Messages app, using AppleScript under the
 * hood. Kept as a static class because the legacy import contract is
 * `IMessageSender.send({...})` and multiple call sites rely on it.
 */
export class IMessageSender {
  static async send(payload: IMessagePayload): Promise<void> {
    await sendIMessage(payload);
  }
}
