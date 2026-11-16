import type { CompletionMessage } from '../rose';
import { createLogger } from '../logger';
import { SMS_MAX_BODY_CHARACTERS } from '../smsDeliveryContract';
import type { SupervisorChannel } from './channelDelivery';
import { rewriteNotification, SMS_NOTIFICATION_SYSTEM_PROMPT } from './notificationLlm';

const log = createLogger('SmsNotification');
const MAX_NOTIFICATION_DELIVERY_ATTEMPTS = 3;
export const MAX_NOTIFICATION_CORRECTIONS = MAX_NOTIFICATION_DELIVERY_ATTEMPTS - 1;

interface DeliveryResult {
  success: boolean;
  messageSid?: string;
  error?: string;
  definitiveFailure?: boolean;
  recipientUnreachable?: boolean;
  statusCode?: number;
}

export interface NotificationContent {
  message: string;
  requiredLinks: readonly string[];
  /** An accepted final answer is immutable, even after a provider rejection. */
  preserveText?: boolean;
}

export class NotificationDeliveryError extends Error {
  readonly definitiveFailure: boolean;

  constructor(result: DeliveryResult) {
    super(result.error ?? 'Lifecycle notification delivery failed');
    this.name = 'NotificationDeliveryError';
    this.definitiveFailure = result.definitiveFailure === true;
  }
}

/** Correct rejected notification text without resending an accepted message. */
export async function deliverNotificationMessage(
  config: NotificationContent & {
    channel: SupervisorChannel;
    agentId?: string;
    /** Archive owner when no agent is bound (per-user root). */
    userId?: string;
    eventType?: unknown;
    correctionBudget?: { remaining: number };
    send: (message: string) => Promise<DeliveryResult>;
  }
): Promise<DeliveryResult & { message: string }> {
  const requiredLinks = config.requiredLinks;
  const messages: CompletionMessage[] = [
    { role: 'system', content: SMS_NOTIFICATION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        event_type: config.eventType,
        source_notification: config.message,
        required_links: requiredLinks,
      }),
    },
  ];
  let message = config.message;
  const correctionBudget = config.correctionBudget ?? { remaining: MAX_NOTIFICATION_CORRECTIONS };
  for (let attempt = 0; attempt < MAX_NOTIFICATION_DELIVERY_ATTEMPTS; attempt++) {
    let error: string | undefined;
    if (message.trim() === '') {
      error = 'Notification message must not be empty.';
    } else if (config.channel === 'SMS' && message.length > SMS_MAX_BODY_CHARACTERS) {
      error = `Message body should be at most ${SMS_MAX_BODY_CHARACTERS} character(s); received ${message.length}, including all text and links.`;
    } else if (requiredLinks.some((link) => !message.includes(link))) {
      error = 'Notification message omitted a required link. Preserve every required link exactly.';
    }
    const result: DeliveryResult = error
      ? { success: false, definitiveFailure: true, error }
      : await config.send(message);
    if (result.success || config.preserveText) return { ...result, message };
    log.warn('Notification delivery failed', {
      agentId: config.agentId,
      channel: config.channel,
      attempt: attempt + 1,
      definitiveFailure: result.definitiveFailure,
      error: result.error,
    });
    // A timeout/disconnect does not prove non-delivery. Rewriting and sending
    // again could duplicate a message already accepted by the provider.
    const correctable =
      error !== undefined || result.statusCode === 400 || result.statusCode === 422;
    if (!result.definitiveFailure || result.recipientUnreachable || !correctable)
      return { ...result, message };
    if (attempt + 1 === MAX_NOTIFICATION_DELIVERY_ATTEMPTS) return { ...result, message };
    if (correctionBudget.remaining === 0) return { ...result, message };
    correctionBudget.remaining--;
    const callId = `notification-delivery-${attempt}`;
    messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name: 'send_notification', arguments: JSON.stringify({ message }) },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: callId,
        content: JSON.stringify({ success: false, error: result.error }),
      }
    );
    try {
      message = await rewriteNotification(messages, config.agentId, config.userId);
    } catch (generationError) {
      return {
        success: false,
        definitiveFailure: true,
        message,
        error: `Notification rewrite failed: ${generationError instanceof Error ? generationError.message : String(generationError)}; delivery error: ${result.error ?? 'unknown'}`,
      };
    }
  }
  throw new Error('Notification delivery attempts exhausted without a result');
}
