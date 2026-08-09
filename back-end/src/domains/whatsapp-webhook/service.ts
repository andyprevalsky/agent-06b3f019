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
  parseWhatsAppInbound,
  isStatusOnlyEvent,
  type WebhookVerification,
} from './service.validation';
import { getWhatsAppConfig, verifyMetaSignature } from '../../providers/whatsappCloud';
import { provisionUserByPhone, getInboundSeq } from './repo';
import { createSignupBonusCredit } from '../../providers/credits';
import {
  handleSmsSupervisorMessage,
  SUPERVISOR_FALLBACK_MESSAGE,
} from '../../providers/smsSupervisor';
import { recordInboundSms } from '../../providers/smsSupervisor/sessionStore';
import { sendOnChannel } from '../../providers/smsSupervisor/channelDelivery';
import { createLogger } from '../../providers/logger';
import { alertError } from '../../providers/errorAlert';

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
  requestStart: number
): Promise<void> {
  const mySeq = await recordInboundSms(userId, messageBody);

  log.info('Routing to supervisor (WhatsApp)', {
    userId,
    messageLength: messageBody.length,
    mySeq,
  });

  // Run async — the webhook must return 200 promptly or Meta retries. The
  // supervisor sends its reply over WhatsApp.
  handleSmsSupervisorMessage({
    userId,
    phoneNumber: fromPhone,
    inboundMessage: messageBody,
    mySeq,
    inboundAlreadyPersisted: true,
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

export async function handleInboundWhatsApp(
  input: InboundWhatsAppInput
): Promise<InboundWhatsAppResult> {
  const requestStart = Date.now();
  const { appSecret } = getWhatsAppConfig();

  // Verify Meta's X-Hub-Signature-256 in production (mirrors Surge HMAC gating).
  if (appSecret !== undefined && appSecret !== '' && IS_PRODUCTION) {
    const rawBody = input.rawBody ?? JSON.stringify(input.body);
    if (!verifyMetaSignature(input.signatureHeader, rawBody, appSecret)) {
      log.error('Invalid WhatsApp signature');
      throw new InvalidSignatureError();
    }
  }

  const body = input.body;

  // Delivery/read receipts for OUTBOUND messages carry no inbound text.
  // Acknowledge and drop — never route to the supervisor.
  if (isStatusOnlyEvent(body)) {
    log.info('WhatsApp status-only event, acknowledged', {
      keys: Object.keys(body),
    });
    return { ok: true };
  }

  const parsed = parseWhatsAppInbound(body);
  if (!parsed) {
    // Non-text media, empty, or unrecognized shape. Acknowledge so Meta stops
    // retrying; log for visibility. (Media handling is a follow-up.)
    log.warn('No inbound WhatsApp text to route', {
      keys: Object.keys(body),
      raw: JSON.stringify(body).substring(0, 500),
    });
    return { ok: true };
  }

  const { fromPhone, messageBody, messageId } = parsed;
  log.info('Inbound WhatsApp received', {
    from: fromPhone.substring(0, 7) + '****',
    bodyLength: messageBody.length,
    bodyPreview: messageBody.substring(0, 100),
    messageId,
  });

  // An inbound WhatsApp message proves possession of the number (Meta verified
  // the sender), so a first-time texter is provisioned silently — same as SMS.
  const { user, created } = await provisionUserByPhone(fromPhone);
  if (created) {
    log.info('Provisioned new WhatsApp user (first contact)', {
      userId: user.userId,
      phone: fromPhone.substring(0, 7) + '****',
    });
    try {
      await createSignupBonusCredit(user.userId);
    } catch (error) {
      log.error('Failed to create signup bonus credit for provisioned user', {
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await routeToSupervisor(user.userId, fromPhone, messageBody, requestStart);
  return { ok: true };
}
