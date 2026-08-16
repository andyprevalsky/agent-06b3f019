/**
 * WhatsApp Cloud API (Meta) transport.
 *
 * Outbound send + inbound webhook signature verification for the Meta WhatsApp
 * Business Cloud API. This is the WhatsApp analogue of `smsQueue.ts` (Surge):
 * `sendWhatsAppMessage` returns the SAME result shape as `sendSms` so the SMS
 * supervisor's delivery loop can dispatch to either channel with no branching
 * beyond picking the sender.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

import crypto from 'node:crypto';
import { createHmac, timingSafeEqual } from './crypto';
import { createLogger } from './logger';
import { logTruncate } from '../utils/log';
import { archiveJson } from './traceArchive';

const log = createLogger('WhatsApp');

const DEFAULT_GRAPH_API_VERSION = 'v21.0';

export function getWhatsAppConfig(): {
  phoneNumberId?: string;
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  graphApiVersion: string;
} {
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET,
    verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    graphApiVersion:
      process.env.WHATSAPP_GRAPH_API_VERSION !== undefined &&
      process.env.WHATSAPP_GRAPH_API_VERSION !== ''
        ? process.env.WHATSAPP_GRAPH_API_VERSION
        : DEFAULT_GRAPH_API_VERSION,
  };
}

/**
 * Verify a Meta webhook payload signature.
 *
 * Meta signs the RAW request body with the app secret (HMAC-SHA256) and sends
 * it as `X-Hub-Signature-256: sha256=<hex>`. We recompute over the exact raw
 * bytes and compare in constant time. Mirrors `validateSurgeSignature`.
 */
export function verifyMetaSignature(
  signatureHeader: string | undefined,
  rawBody: string,
  appSecret: string
): boolean {
  if (signatureHeader === undefined || signatureHeader === null || signatureHeader === '') {
    return false;
  }
  const [scheme, signature] = signatureHeader.split('=');
  if (scheme !== 'sha256' || signature === undefined || signature === '') {
    return false;
  }

  const hmac = createHmac('sha256', appSecret);
  hmac.update(rawBody, 'utf-8');
  const expected = hmac.digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(sigBuffer, expectedBuffer);
}

interface WhatsAppArchiveOptions {
  archiveRootAgentId?: string;
  archiveContext?: Record<string, unknown>;
}

async function archiveWhatsAppTransportBoundary(params: {
  rootAgentId?: string;
  requestBody: Record<string, unknown>;
  response: unknown;
  statusCode?: number;
  success: boolean;
  context?: Record<string, unknown>;
}): Promise<void> {
  const rootAgentId = params.rootAgentId;
  if (rootAgentId === undefined || rootAgentId === '') return;
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ request: params.requestBody, ts: Date.now() }))
    .digest('hex')
    .slice(0, 24);
  try {
    await archiveJson({
      rootAgentId,
      objectPath: `provider/whatsapp/cloud/${Date.now()}-${fingerprint}.json.gz.enc`,
      value: {
        provider: 'whatsapp-cloud',
        request: {
          method: 'POST',
          url: '/{version}/{phoneNumberId}/messages',
          body: params.requestBody,
        },
        response: params.response,
        status_code: params.statusCode,
        success: params.success,
        context: params.context ?? {},
      },
    });
  } catch (error) {
    log.warn('WhatsApp provider archive failed', {
      rootAgentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface WhatsAppSendResponse {
  messages?: { id: string }[];
  [key: string]: unknown;
}

/**
 * Meta error codes meaning "this number cannot receive a proactive message from
 * us" — so we should stop mirroring lifecycle notifications to it (until it
 * texts our WhatsApp again, which re-enables it):
 *   131026 — message undeliverable (recipient not a valid WhatsApp user / can't receive)
 *   131030 — recipient phone number not in the allowed list (dev/test mode)
 *   131047 / 470 — re-engagement required (outside the 24h customer-service window)
 * Auth (190/401), rate-limit (131056/429), and transient errors are NOT here —
 * those are our-side or temporary, not a property of the recipient number.
 */
const WHATSAPP_UNREACHABLE_ERROR_CODES = new Set([131026, 131030, 131047, 470]);

function extractWhatsAppErrorCode(errorText: string): number | null {
  try {
    const parsed = JSON.parse(errorText) as { error?: { code?: unknown } };
    const code = parsed.error?.code;
    return typeof code === 'number' ? code : null;
  } catch {
    return null;
  }
}

/**
 * Send a WhatsApp text message via the Meta Cloud API.
 *
 * Returns the same `{ success, messageSid?, error?, definitiveFailure? }` shape
 * as `sendSms` so it is a drop-in delivery function for the SMS supervisor.
 *
 * NOTE: WhatsApp only allows free-form (session) messages within 24h of the
 * user's last inbound message. Replying to an inbound message always falls
 * inside that window, so the conversational supervisor path never needs an
 * approved template.
 */
export async function sendWhatsAppMessage(
  phoneNumber: string,
  message: string,
  options: WhatsAppArchiveOptions = {}
): Promise<{
  success: boolean;
  messageSid?: string;
  error?: string;
  definitiveFailure?: boolean;
  /** Meta reports this number can't receive a proactive message — stop mirroring. */
  recipientUnreachable?: boolean;
}> {
  const { phoneNumberId, accessToken, graphApiVersion } = getWhatsAppConfig();

  if (
    phoneNumberId === undefined ||
    phoneNumberId === '' ||
    accessToken === undefined ||
    accessToken === ''
  ) {
    log.error('WhatsApp credentials not configured');
    return { success: false, error: 'WhatsApp not configured', definitiveFailure: true };
  }

  // Meta expects the recipient in international format without a leading '+'.
  const to = phoneNumber.replace(/^\+/, '');
  const requestBody = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: message },
  };

  try {
    const response = await fetch(
      `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        // Undici has no total-request deadline; bound it so supervisor delivery
        // and fallback handling can't hang indefinitely on a stuck connection.
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      let errorText: string;
      try {
        errorText = await response.text();
      } catch (error) {
        errorText = `Unable to read WhatsApp error response: ${error instanceof Error ? error.message : String(error)}`;
      }
      log.error('WhatsApp API error', { status: response.status, error: logTruncate(errorText) });
      await archiveWhatsAppTransportBoundary({
        rootAgentId: options.archiveRootAgentId,
        requestBody,
        response: { error: errorText },
        statusCode: response.status,
        success: false,
        context: options.archiveContext,
      });
      const errorCode = extractWhatsAppErrorCode(errorText);
      const recipientUnreachable =
        errorCode !== null && WHATSAPP_UNREACHABLE_ERROR_CODES.has(errorCode);
      // 429 (throttle) and 5xx (Meta outage) are transient — the supervisor's
      // delivery loop may retry them. Only other 4xx are permanent. A
      // recipient-unreachable code is definitive for THIS recipient.
      const transient = response.status === 429 || response.status >= 500;
      return {
        success: false,
        error: `WhatsApp API error: ${response.status}`,
        definitiveFailure: recipientUnreachable || !transient,
        ...(recipientUnreachable ? { recipientUnreachable: true } : {}),
      };
    }

    const result = (await response.json()) as WhatsAppSendResponse;
    const messageSid = result.messages?.[0]?.id;
    await archiveWhatsAppTransportBoundary({
      rootAgentId: options.archiveRootAgentId,
      requestBody,
      response: result,
      statusCode: response.status,
      success: true,
      context: { ...(options.archiveContext ?? {}), message_id: messageSid },
    });
    log.info('Sent via WhatsApp Cloud API', {
      messageId: messageSid,
      phone: phoneNumber.substring(0, 7) + '****',
    });

    return { success: true, messageSid };
  } catch (error) {
    log.error('Error sending WhatsApp message', {
      error: error instanceof Error ? error.message : String(error),
    });
    await archiveWhatsAppTransportBoundary({
      rootAgentId: options.archiveRootAgentId,
      requestBody,
      response: { error: error instanceof Error ? error.message : String(error) },
      success: false,
      context: options.archiveContext,
    });
    return { success: false, error: String(error) };
  }
}
