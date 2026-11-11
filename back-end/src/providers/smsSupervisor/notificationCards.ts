import { createLogger } from '../logger';
import {
  getLinqChat,
  isLinqEnabled,
  sendLinqPayload,
  type LinqSendOptions,
  type LinqSendResult,
} from '../linq';
import { sendLinqNotificationCard, type LinqNotificationCard } from '../linqCards';
import type { NotificationContent } from './notificationDelivery';

const log = createLogger('NotificationCards');

export function plannerNotificationContent(
  message: string,
  sourceText: string,
  isQuestion: boolean
): NotificationContent {
  const requiredLinks = sourceText.match(/https?:\/\/[^\s]+/g) ?? [];
  return {
    message,
    requiredLinks,
    ...(requiredLinks[0]
      ? {
          card: {
            url: requiredLinks[0],
            title: isQuestion ? 'Rose needs your input' : 'An update from Rose',
            subtitle: sourceText,
            button: 'Open link',
          },
        }
      : {}),
  };
}

/** An accepted text/receipt remains the transcript anchor, even if its card fails. */
export async function deliverNotificationCard(
  phone: string,
  card: LinqNotificationCard,
  acceptedText: LinqSendResult,
  options?: LinqSendOptions
): Promise<void> {
  if (!isLinqEnabled(phone)) return;
  try {
    const chat = await getLinqChat(phone);
    const result = await sendLinqNotificationCard({
      card,
      service: chat?.service,
      sendPayload: (payload) =>
        sendLinqPayload(phone, payload, {
          ...options,
          abortSignal: AbortSignal.timeout(10_000),
        }),
      fallback: async () => acceptedText,
    });
    if (!result.success) {
      log.warn('Linq notification card failed after text delivery', {
        agentId: options?.archiveRootAgentId,
        definitiveFailure: result.definitiveFailure,
      });
    }
  } catch {
    log.warn('Linq notification card unavailable after text delivery', {
      agentId: options?.archiveRootAgentId,
    });
  }
}
