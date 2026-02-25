/**
 * SMS Webhook Routes
 *
 * Handles inbound SMS from Surge. Routes through:
 * 1. Shortcode fast-path: "Approve XXXXX" bypasses LLM for instant write-lock approval
 * 2. SMS Supervisor Agent: Everything else goes through the LLM-powered supervisor
 *
 * Surge webhook payload (message.received):
 *   { id, body, conversation: { contact: { phone_number }, phone_number: { number } } }
 *
 * Surge signature: Surge-Signature header with HMAC-SHA256
 *   Format: "t=<timestamp>,v1=<hmac>"
 *   Signed payload: "<timestamp>.<raw_body>"
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { getTemporalClient } from '../lib/temporal';
import { sendSms } from '../lib/smsQueue';
import { SMS_TEMPLATES } from '../lib/smsTemplates';
import { handleSmsSupervisorMessage } from '../lib/smsSupervisor';
import { lookupAndConsumeShortcode } from '../lib/smsSupervisor/shortcodes';

const router = Router();

// Regex for shortcode approval: "approve XXXXX" or "yes XXXXX"
const SHORTCODE_REGEX = /^(?:approve|yes)\s+([A-Z0-9]{5})$/i;

/**
 * Validate Surge webhook signature (HMAC-SHA256)
 *
 * Surge sends: Surge-Signature: t=<timestamp>,v1=<hmac>
 * Signed payload: "<timestamp>.<raw_json_body>"
 */
function validateSurgeSignature(
  req: Request,
  signingSecret: string
): boolean {
  const signatureHeader = req.headers['surge-signature'] as string;
  if (!signatureHeader) {
    return false;
  }

  // Parse "t=1737830031,v1=abc123..."
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(',')) {
    const [key, ...valueParts] = part.split('=');
    parts[key] = valueParts.join('=');
  }

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) {
    return false;
  }

  // Reject if timestamp is older than 5 minutes
  const timestampAge = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (timestampAge > 300) {
    console.warn('[SMS Webhook] Surge signature too old', { timestampAge });
    return false;
  }

  // Reconstruct signed payload: "<timestamp>.<raw_body>"
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const signedPayload = `${timestamp}.${rawBody}`;

  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(signedPayload, 'utf-8');
  const expectedSignature = hmac.digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

/**
 * Extract phone number and body from Surge webhook payload
 *
 * Surge message.received payload:
 * {
 *   id: "msg_...",
 *   body: "Hello",
 *   conversation: {
 *     contact: { phone_number: "+19729777432", ... },
 *     phone_number: { number: "+18001234567", ... }
 *   }
 * }
 */
function parseSurgePayload(body: any): { fromPhone: string; messageBody: string } | null {
  // Surge wraps the message under a `data` envelope
  const data = body?.data ?? body;
  const messageBody = (data?.body as string || '').trim();
  const fromPhone = data?.conversation?.contact?.phone_number as string;

  if (!fromPhone || !messageBody) {
    return null;
  }

  return { fromPhone, messageBody };
}

/**
 * POST /api/sms/inbound - Surge webhook for inbound SMS (message.received)
 */
router.post('/inbound', async (req: Request, res: Response) => {
  const requestStart = Date.now();

  try {
    const signingSecret = process.env.SURGE_SIGNING_SECRET;

    // Validate Surge signature in production
    if (signingSecret && process.env.NODE_ENV === 'production') {
      if (!validateSurgeSignature(req, signingSecret)) {
        console.error('[SMS Webhook] Invalid Surge signature', {
          headers: Object.keys(req.headers),
        });
        return res.status(403).json({ error: 'Invalid signature' });
      }
    }

    // Log raw payload shape on every request so we can verify Surge's format
    console.log('[SMS Webhook] Raw Surge payload', {
      keys: Object.keys(req.body || {}),
      type: req.body?.type,
      hasBody: 'body' in (req.body || {}),
      hasConversation: 'conversation' in (req.body || {}),
      conversationKeys: req.body?.conversation ? Object.keys(req.body.conversation) : [],
      contactKeys: req.body?.conversation?.contact ? Object.keys(req.body.conversation.contact) : [],
      raw: JSON.stringify(req.body).substring(0, 500),
    });

    const parsed = parseSurgePayload(req.body);

    console.log('[SMS Webhook] Inbound SMS received', {
      from: parsed?.fromPhone?.substring(0, 7) + '****',
      bodyLength: parsed?.messageBody.length,
      bodyPreview: parsed?.messageBody.substring(0, 100),
      rawType: req.body?.type,
    });

    if (!parsed) {
      console.warn('[SMS Webhook] Could not parse Surge payload', {
        hasBody: !!req.body?.body,
        hasConversation: !!req.body?.conversation,
        keys: Object.keys(req.body || {}),
      });
      return res.status(400).json({ error: 'Invalid message format' });
    }

    const { fromPhone, messageBody } = parsed;

    // Look up user by phone number
    const user = await prisma.user.findFirst({
      where: { phone: fromPhone },
    });

    if (!user) {
      console.log('[SMS Webhook] Unknown phone number', {
        phone: fromPhone?.substring(0, 7) + '****',
      });
      await sendSms(fromPhone, SMS_TEMPLATES.unknownPhone());
      return res.json({ ok: true });
    }

    console.log('[SMS Webhook] User found', {
      userId: user.userId,
      phone: fromPhone?.substring(0, 7) + '****',
    });

    // ============================================
    // FAST PATH: Shortcode approval (no LLM needed)
    // ============================================
    const shortcodeMatch = messageBody.match(SHORTCODE_REGEX);
    if (shortcodeMatch) {
      const code = shortcodeMatch[1].toUpperCase();

      console.log('[SMS Webhook] Shortcode approval attempt', {
        code,
        userId: user.userId,
      });

      const shortcodeResult = await lookupAndConsumeShortcode(code, user.userId);

      if (shortcodeResult) {
        console.log('[SMS Webhook] Shortcode valid, approving', {
          code,
          attentionRequestId: shortcodeResult.attentionRequestId,
          agentId: shortcodeResult.agentId,
          workflowId: shortcodeResult.workflowId,
        });

        // Update the attention request
        await prisma.agentAttentionRequest.update({
          where: { id: shortcodeResult.attentionRequestId },
          data: { userResponse: 'Approved via SMS shortcode' },
        });

        // Signal the workflow
        try {
          const client = await getTemporalClient();
          const handle = client.workflow.getHandle(shortcodeResult.workflowId);
          await handle.signal('receive_user_response', 'Approved via SMS shortcode');

          console.log('[SMS Webhook] Signaled workflow with shortcode approval', {
            workflowId: shortcodeResult.workflowId,
            agentId: shortcodeResult.agentId,
          });
        } catch (error) {
          console.error('[SMS Webhook] Failed to signal workflow for shortcode', {
            workflowId: shortcodeResult.workflowId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Send confirmation
        const agentPrefix = shortcodeResult.agentId.substring(0, 6);
        await sendSms(fromPhone, `[${agentPrefix}] Approved! Agent is continuing.`);

        console.log('[SMS Webhook] Shortcode approval complete', {
          code,
          durationMs: Date.now() - requestStart,
        });

        return res.json({ ok: true });
      }

      // Invalid/expired shortcode
      console.log('[SMS Webhook] Shortcode not found or expired', { code });
      await sendSms(fromPhone, `Code "${code}" not found or expired. Check the code and try again.`);
      return res.json({ ok: true });
    }

    // ============================================
    // FAST PATH: /clear command (reset SMS session)
    // ============================================
    if (messageBody.toLowerCase() === '/clear') {
      console.log('[SMS Webhook] /clear command received', { userId: user.userId });

      await prisma.smsSession.upsert({
        where: { userId: user.userId },
        update: { messages: JSON.stringify([]) },
        create: { userId: user.userId, messages: JSON.stringify([]) },
      });

      await sendSms(fromPhone, 'Session cleared.');
      return res.json({ ok: true });
    }

    // ============================================
    // MAIN PATH: Route through SMS Supervisor Agent
    // ============================================
    console.log('[SMS Webhook] Routing to SMS Supervisor', {
      userId: user.userId,
      messageLength: messageBody.length,
    });

    // Run async — don't block the webhook response
    // The supervisor sends its response via Surge API
    handleSmsSupervisorMessage({
      userId: user.userId,
      phoneNumber: fromPhone,
      inboundMessage: messageBody,
    })
      .then((result) => {
        console.log('[SMS Webhook] Supervisor completed', {
          userId: user.userId,
          responseLength: result.responseText.length,
          toolsExecuted: result.toolsExecuted,
          totalDurationMs: Date.now() - requestStart,
        });
      })
      .catch((error) => {
        console.error('[SMS Webhook] Supervisor failed', {
          userId: user.userId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          durationMs: Date.now() - requestStart,
        });

        // Send error SMS as fallback
        sendSms(fromPhone, "Sorry, something went wrong. Please try again.")
          .catch(smsError => {
            console.error('[SMS Webhook] Failed to send error SMS', {
              error: smsError instanceof Error ? smsError.message : String(smsError),
            });
          });
      });

    // Return 200 immediately (supervisor sends response async via Surge)
    return res.json({ ok: true });
  } catch (error) {
    console.error('[SMS Webhook] Error processing inbound SMS', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      durationMs: Date.now() - requestStart,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
