/**
 * i-message-queue-service — runtime layer
 *
 * Thin public entry for the iMessage outbound-queue poller. Exposes the
 * {@link IMessageQueueService} static class, which the sync-manager runtime
 * starts on boot and stops on shutdown. Polls backend for queued iMessages
 * and sends them via the AppleScript sender.
 *
 * Layer rule: runtime imports own service + own config + shared providers
 * only. No raw data access, no inline business logic.
 */

import { logConsole, logConsoleError } from '../../base/logger';
import { LOG_TAG, POLL_INTERVAL_MS } from './config';
import { drainQueue } from './service';

/**
 * Service to poll backend for queued iMessages and send them via AppleScript.
 */
export class IMessageQueueService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isProcessing = false;

  /**
   * Start polling for queued iMessages.
   */
  static start(): void {
    if (this.intervalId) {
      logConsole(LOG_TAG, 'Already running');
      return;
    }

    logConsole(LOG_TAG, 'Starting queue polling...');

    // Immediate first poll.
    this.runOnce().catch((err) => logConsoleError(LOG_TAG, 'Initial poll error', err));

    // Start periodic polling.
    this.intervalId = setInterval(() => {
      this.runOnce().catch((err) => logConsoleError(LOG_TAG, 'Poll error', err));
    }, POLL_INTERVAL_MS);
  }

  /**
   * Stop polling.
   */
  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logConsole(LOG_TAG, 'Stopped');
    }
  }

  /**
   * Check if service is running.
   */
  static isActive(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Drain the queue once, guarding against re-entrance when a previous tick
   * is still in flight (fetches can take longer than POLL_INTERVAL_MS).
   */
  private static async runOnce(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      await drainQueue();
    } finally {
      this.isProcessing = false;
    }
  }
}
