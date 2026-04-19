/**
 * iMessage Queue Service
 *
 * Polls backend for queued iMessages and sends them via AppleScript.
 * Flow: Poll GET /api/imessage/queue/pop -> IMessageSender.send() -> Done
 */

import { AuthService } from './auth';
import { IMessageSender } from './iMessageSender';
import { config } from '../base/config';
import { logConsole, logConsoleError } from '../base/logger';

interface QueuedMessage {
  id: string;
  phone_number: string;
  message: string;
  agent_id: string;
  created_at: string;
}

interface PopResponse {
  message: QueuedMessage | null;
}

/**
 * Service to poll backend for queued iMessages and send them via AppleScript.
 */
export class IMessageQueueService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static readonly POLL_INTERVAL_MS = 10 * 1000; // 10 seconds
  private static isProcessing = false;

  /**
   * Start polling for queued iMessages.
   */
  static start(): void {
    if (this.intervalId) {
      logConsole('IMessageQueueService', 'Already running');
      return;
    }

    logConsole('IMessageQueueService', 'Starting queue polling...');

    // Immediate first poll
    this.processQueue().catch((err) =>
      logConsoleError('IMessageQueueService', 'Initial poll error', err)
    );

    // Start periodic polling
    this.intervalId = setInterval(() => {
      this.processQueue().catch((err) =>
        logConsoleError('IMessageQueueService', 'Poll error', err)
      );
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Stop polling.
   */
  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logConsole('IMessageQueueService', 'Stopped');
    }
  }

  /**
   * Process queued messages by popping and sending.
   */
  private static async processQueue(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const session = await AuthService.getSession();
      if (!session) {
        return;
      }

      // Keep popping messages until queue is empty
      let hasMore = true;
      while (hasMore) {
        const response = await fetch(`${config.apiUrl}/api/imessage/queue/pop`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (!response.ok) {
          if (response.status !== 401) {
            logConsoleError('IMessageQueueService', 'Pop request failed', response.statusText);
          }
          return;
        }

        const data = (await response.json()) as PopResponse;

        if (!data.message) {
          hasMore = false;
          continue;
        }

        // Send the message via AppleScript
        await this.sendMessage(data.message);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Send a single message via iMessage.
   */
  private static async sendMessage(msg: QueuedMessage): Promise<void> {
    const maskedPhone = msg.phone_number.substring(0, 4) + '****';

    try {
      await IMessageSender.send({
        to: msg.phone_number,
        message: msg.message,
      });

      logConsole('IMessageQueueService', `Sent iMessage to ${maskedPhone}`);
    } catch (err) {
      logConsoleError('IMessageQueueService', `Failed to send to ${maskedPhone}`, err);
      // Message is already popped from queue, so error is logged but not retried
      // Consider adding error reporting to backend in the future
    }
  }

  /**
   * Check if service is running.
   */
  static isActive(): boolean {
    return this.intervalId !== null;
  }
}
