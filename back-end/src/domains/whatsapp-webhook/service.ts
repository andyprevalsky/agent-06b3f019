/**
 * WhatsApp Webhook Domain Service
 *
 * Inbound processing for the Meta WhatsApp Cloud API — the WhatsApp analogue of
 * `sms-webhook/service.ts`. It is deliberately thin: after verifying the
 * signature, parsing the payload, and provisioning the user, it hands the
 * message to the SAME `handleSmsSupervisorMessage` the SMS path uses, with
 * `channel: 'WHATSAPP'`. The supervisor's reply then goes back over WhatsApp.
 *
 * Two-way conversational flow (mirrors SMS):
 *   Meta → POST /api/whatsapp/webhook → handleInboundWhatsApp
 *     → provisionUserByPhone → routeToSupervisor
 *     → handleSmsSupervisorMessage(channel: WHATSAPP) → reply via WhatsApp
 */

import { IS_PRODUCTION } from './config';
import {
  resolveWebhookVerification,
  parseWhatsAppInboundMessages,
  isStatusOnlyEvent,
  type WebhookVerification,
} from './service.validation';
import { getWhatsAppConfig, verifyMetaSignature } from '../../providers/whatsappCloud';
import { provisionUserByPhone, getInboundSeq } from './repo';
import { markWhatsAppReachable } from '../../providers/whatsappReachability';
import { createSignupBonusCredit } from '../../providers/credits';
import {
  handleSmsSupervisorMessage,
  SUPERVISOR_FALLBACK_MESSAGE,
} from '../../providers/smsSupervisor';
import { recordInboundSms } from '../../providers/smsSupervisor/sessionStore';
import { sendOnChannel } from '../../providers/smsSupervisor/channelDelivery';
import type { WhatsAppMediaAttachment } from '../../providers/smsSupervisor/inboundMedia';
import { createLogger } from '../../providers/logger';
import { alertError } from '../../providers/errorAlert';
import { acquireLease, releaseLease } from '../../providers/sharedState';

const log = createLogger('WhatsApp Webhook');

export class InvalidSignatureError extends Error {
  constructor() {
    super('Invalid signature');
  }
}

// ---------------------------------------------------------------------------
// GET subscription-verification handshake
// ---------------------------------------------------------------------------

/**
 * Resolve Meta's GET webhook verification. Returns the challenge string to echo
 * (200 text/plain) when the verify token matches, else null (respond 403).
 */
export function handleWebhookVerification(params: WebhookVerification): string | null {
  const { verifyToken } = getWhatsAppConfig();
  const challenge = resolveWebhookVerification(params, verifyToken);
  log.info('Webhook verification', {
    mode: params.mode,
    tokenMatched: String(challenge !== null),
  });
  return challenge;
}

// ---------------------------------------------------------------------------
// Supervisor routing (main path)
// ---------------------------------------------------------------------------

/* c8 ignore start -- routeToSupervisor delegates to handleSmsSupervisorMessage (excluded smsSupervisor module) */
async function routeToSupervisor(
  userId: string,
  fromPhone: string,
  messageBody: string,
  messageId: string,
  attachments: WhatsAppMediaAttachment[],
  requestStart: number
): Promise<void> {
  const persistedInbound = [
    messageBody,
    attachments.length > 0 ? `[${attachments.length} attachment(s)]` : '',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  const mySeq = await recordInboundSms(userId, persistedInbound, messageId);

  log.info('Routing to supervisor (WhatsApp)', {
    userId,
    messageLength: messageBody.length,
    attachmentCount: attachments.length,
    mySeq,
  });

  // Run async — the webhook must return 200 promptly or Meta retries. The
  // supervisor sends its reply over WhatsApp.
  handleSmsSupervisorMessage({
    userId,
    phoneNumber: fromPhone,
    inboundMessage: messageBody,
    inboundMessageId: messageId,
    mySeq,
    inboundAlreadyPersisted: true,
    attachments,
    channel: 'WHATSAPP',
  })
    .then((result) => {
      log.info('Supervisor completed (WhatsApp)', {
        userId,
        mySeq,
        committed: result.committed,
        responseLength: result.responseText.length,
        totalDurationMs: Date.now() - requestStart,
      });
    })
    .catch((error) => handleSupervisorFailure({ userId, fromPhone, mySeq, error }));
}

async function handleSupervisorFailure(input: {
  userId: string;
  fromPhone: string;
  mySeq: number;
  error: unknown;
}): Promise<void> {
  const { userId, fromPhone, mySeq, error } = input;
  log.error('Supervisor failed (WhatsApp)', {
    userId,
    mySeq,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  alertError({
    source: 'whatsapp',
    message: error instanceof Error ? error.message : String(error),
    userId,
    stack: error instanceof Error ? error.stack : undefined,
    context: { mySeq },
  });

  // Gate the fallback on the same seq the run captured: if a newer inbound
  // arrived during our run, stay silent — the newer run owns the reply.
  try {
    const currentSeq = await getInboundSeq(userId);
    if ((currentSeq ?? 0) > mySeq) {
      log.info('Error path: seq advanced, suppressing fallback (WhatsApp)', { userId, mySeq });
      return;
    }
    await sendOnChannel('WHATSAPP', fromPhone, SUPERVISOR_FALLBACK_MESSAGE);
  } catch (sendError) {
    log.error('Failed to send fallback WhatsApp message', {
      error: sendError instanceof Error ? sendError.message : String(sendError),
    });
  }
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Main inbound handler
// ---------------------------------------------------------------------------

export interface InboundWhatsAppInput {
  body: Record<string, unknown>;
  rawBody?: string;
  signatureHeader: string | undefined;
}

export interface InboundWhatsAppResult {
  ok: true;
}

// Dedup of recently-handled Meta message ids, shared by every backend instance.
// Meta re-delivers a webhook when it does not get a timely 2xx, so a slow DB
// turn can re-run the same inbound message, and the retry may land on another
// instance. The first delivery claims the wamid for a day.
const MESSAGE_ID_NAMESPACE = 'whatsapp-wamid';
const MESSAGE_ID_TTL_MS = 24 * 60 * 60 * 1000;
const messageClaims = new Map<string, string>();

export async function alreadyProcessedMessage(messageId: string): Promise<boolean> {
  if (messageId === '') return false;
  const token = await acquireLease(MESSAGE_ID_NAMESPACE, messageId, MESSAGE_ID_TTL_MS);
  if (token === null) return true;
  messageClaims.set(messageId, token);
  return false;
}

/**
 * Release a dedup reservation so a failed message can be reprocessed on Meta's
 * retry. Without this, a throw after the reservation would make the retry a
 * no-op (skipped + 200) and silently drop the inbound message.
 */
export async function releaseProcessedMessage(messageId: string): Promise<void> {
  const token = messageClaims.get(messageId);
  if (token === undefined) return;
  messageClaims.delete(messageId);
  await releaseLease(MESSAGE_ID_NAMESPACE, messageId, token);
}

/** Forget this instance's claim tokens once a delivery batch finishes. */
function forgetMessageClaim(messageId: string): void {
  messageClaims.delete(messageId);
}

export async function handleInboundWhatsApp(
  input: InboundWhatsAppInput
): Promise<InboundWhatsAppResult> {
  const requestStart = Date.now();
  const { appSecret } = getWhatsAppConfig();

  // Verify Meta's X-Hub-Signature-256. In production this is MANDATORY and fails
  // CLOSED: a missing app secret or an absent raw body must reject the request,
  // never bypass verification — otherwise forged inbound messages could trigger
  // provisioning, signup credits, reachability updates, and supervisor runs.
  if (IS_PRODUCTION) {
    if (appSecret === undefined || appSecret === '') {
      log.error('WHATSAPP_APP_SECRET not configured; rejecting inbound WhatsApp in production');
      throw new InvalidSignatureError();
    }
    if (input.rawBody === undefined || input.rawBody === '') {
      log.error('Missing raw body for WhatsApp signature verification; rejecting');
      throw new InvalidSignatureError();
    }
    if (!verifyMetaSignature(input.signatureHeader, input.rawBody, appSecret)) {
      log.error('Invalid WhatsApp signature');
      throw new InvalidSignatureError();
    }
  }

  const body = input.body;

  // Delivery/read receipts for OUTBOUND messages carry no inbound messages.
  // Acknowledge and drop — never route to the supervisor.
  if (isStatusOnlyEvent(body)) {
    log.info('WhatsApp status-only event, acknowledged', {
      keys: Object.keys(body),
    });
    return { ok: true };
  }

  const messages = parseWhatsAppInboundMessages(body);
  if (messages.length === 0) {
    // Unsupported message types, empty, or unrecognized shape. Acknowledge so Meta stops
    // retrying. Log SHAPE only — the raw payload holds the sender's phone number
    // and message text (PII).
    log.warn('No supported inbound WhatsApp message to route', {
      keys: Object.keys(body),
      entryCount: Array.isArray(body.entry) ? body.entry.length : 0,
    });
    return { ok: true };
  }

  // Provision each unique sender once, then route every message in the batch.
  const userIdByPhone = new Map<string, string>();
  for (const { fromPhone, messageBody, messageId, attachments = [] } of messages) {
    if (await alreadyProcessedMessage(messageId)) {
      log.info('Duplicate WhatsApp delivery skipped', { messageId });
      continue;
    }
    // Log shape only — the message body is user PII.
    log.info('Inbound WhatsApp received', {
      from: fromPhone.substring(0, 7) + '****',
      bodyLength: messageBody.length,
      attachmentCount: attachments.length,
      messageId,
    });

    try {
      let userId = userIdByPhone.get(fromPhone);
      if (userId === undefined) {
        // An inbound WhatsApp message proves possession of the number (Meta
        // verified the sender), so a first-time texter is provisioned silently.
        const { user, created } = await provisionUserByPhone(fromPhone);
        userId = user.userId;
        userIdByPhone.set(fromPhone, userId);
        if (created) {
          log.info('Provisioned new WhatsApp user (first contact)', {
            userId,
            phone: fromPhone.substring(0, 7) + '****',
          });
          try {
            await createSignupBonusCredit(userId);
          } catch (error) {
            log.error('Failed to create signup bonus credit for provisioned user', {
              userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        // The user just texted us on WhatsApp, so they are definitively reachable —
        // (re-)enable WhatsApp mirroring of their lifecycle/onboarding notifications.
        await markWhatsAppReachable(userId);
      }

      await routeToSupervisor(userId, fromPhone, messageBody, messageId, attachments, requestStart);
    } catch (error) {
      // Processing failed (e.g. DB error) → release the dedup reservation so
      // Meta's retry reprocesses this message instead of skipping it as a dup.
      await releaseProcessedMessage(messageId);
      throw error;
    }
    forgetMessageClaim(messageId);
  }

  return { ok: true };
}
