/**
 * Lifecycle text/receipt -> existing delivery -> optional Linq companion card.
 * iMessage -> link.open; RCS -> single link part; SMS/unknown -> text.
 *
 * Contract verified with GET /api/partner/v3/experiences on 2026-11-11:
 * link.open accepts only url (2048), title (64), subtitle (120), button (24).
 * https://docs.linqapp.com/channel/imessage/guides/messaging/experiences/
 * https://docs.linqapp.com/channel/imessage/guides/messaging/rich-link-previews/
 * These are URL cards, never Linq agentpay/agentcard payment operations.
 */

export interface LinqNotificationCard {
  /** Existing authorized notification URL, kept byte-for-byte. */
  url: string;
  title: string;
  subtitle: string;
  button?: string;
}

interface CardDeliveryResult {
  success: boolean;
  messageSid?: string;
  error?: string;
  definitiveFailure?: boolean;
  statusCode?: number;
}

function cardCopy(value: string, max: number): string {
  const characters = Array.from(value.replace(/\s+/g, ' ').trim());
  return characters.length <= max
    ? characters.join('')
    : `${characters.slice(0, max - 1).join('')}…`;
}

/** No API request or capability guess: unknown services stay on the text path. */
export function buildLinqNotificationPayload(
  card: LinqNotificationCard,
  service: string | undefined
): Record<string, unknown> | undefined {
  // Do not normalize/re-encode signed or attention-request URLs.
  if (card.url.length > 2048 || card.url.trim() !== card.url) return undefined;
  try {
    const url = new URL(card.url);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  } catch {
    return undefined;
  }
  if (service?.toLowerCase() === 'imessage') {
    return {
      experience: {
        name: 'link',
        action: 'open',
        params: {
          url: card.url,
          title: cardCopy(card.title, 64),
          subtitle: cardCopy(card.subtitle, 120),
          button: cardCopy(card.button ?? 'View on RoseLabs', 24),
        },
      },
    };
  }
  if (service?.toLowerCase() === 'rcs') {
    return { parts: [{ type: 'link', value: card.url }] };
  }
  return undefined;
}

/**
 * Parent boundary helper: sendLinqNotificationCard({card, service, sendPayload,
 * fallback}). Bind sendPayload to sendLinqPayload(phone, payload, options), and
 * fallback to the existing text sender. Capability/URL ineligibility uses text;
 * after a send, only a definitive unsupported rejection permits fallback.
 * Never retry/fall back after an ambiguous failure or a thrown timeout.
 *
 * Lifecycle callers already send the complete text/receipt first, so their
 * fallback returns that accepted result without sending a second text. The
 * companion card's failure must not trigger a retry of the accepted receipt.
 */
export async function sendLinqNotificationCard<T extends CardDeliveryResult>(config: {
  card: LinqNotificationCard;
  service: string | undefined;
  sendPayload: (message: Record<string, unknown>) => Promise<T>;
  fallback: () => Promise<T>;
}): Promise<T> {
  const payload = buildLinqNotificationPayload(config.card, config.service);
  if (!payload) return config.fallback();
  const result = await config.sendPayload(payload);
  if (
    !result.success &&
    result.definitiveFailure === true &&
    /\b(?:2018|4005)\b|unsupported|not support/i.test(result.error ?? '')
  ) {
    return config.fallback();
  }
  return result;
}
