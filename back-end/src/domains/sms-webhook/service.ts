/**
 * SMS Webhook Domain Service
 *
 * Business logic for inbound SMS processing:
 * 1. Surge signature validation (delegated to service.validation.ts)
 * 2. Payload parsing (delegated to service.validation.ts)
 * 3. Shortcode fast-path approval (no LLM)
 * 4. /clear command (session + agent teardown)
 * 5. SMS Supervisor routing (LLM-powered)
 */

import * as repo from './repo';
import { SURGE_SIGNING_SECRET, IS_PRODUCTION } from './config';
import {
  validateSurgeSignature,
  parseSurgePayload,
  parseSurgeDeliveryEvent,
  type SurgeDeliveryStatusEvent,
} from './service.validation';
import type { ParsedSurgeMessage } from './types';
import { deleteAgentRecursive } from '../../providers/agentKill';
import { sendSms } from '../../providers/smsQueue';
import { createSignupBonusCredit } from '../../providers/credits';
import {
  handleSmsSupervisorMessage,
  SUPERVISOR_FALLBACK_MESSAGE,
} from '../../providers/smsSupervisor';
import { createLogger } from '../../providers/logger';
import { alertError } from '../../providers/errorAlert';
import { recordInboundSms } from '../../providers/smsSupervisor/sessionStore';
import { withCommitLock } from '../../providers/smsSupervisor/supervisorHandler';

const log = createLogger('SMS Webhook');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class InvalidSignatureError extends Error {
  constructor() {
    super('Invalid signature');
  }
}

export class InvalidPayloadError extends Error {
  constructor() {
    super('Invalid message format');
  }
}

// ---------------------------------------------------------------------------
// Per-user AbortControllers for in-flight supervisor runs.
// /clear aborts all active runs for a user so they don't send SMS after
// session reset.
// ---------------------------------------------------------------------------

const activeSupervisorRuns = new Map<string, Set<AbortController>>();

function registerSupervisorRun(userId: string): AbortController {
  const controller = new AbortController();
  if (!activeSupervisorRuns.has(userId)) {
    activeSupervisorRuns.set(userId, new Set());
  }
  activeSupervisorRuns.get(userId)!.add(controller);
  return controller;
}

function unregisterSupervisorRun(userId: string, controller: AbortController): void {
  const runs = activeSupervisorRuns.get(userId);
  if (runs) {
    runs.delete(controller);
    if (runs.size === 0) activeSupervisorRuns.delete(userId);
  }
}

function abortAllSupervisorRuns(userId: string): void {
  const runs = activeSupervisorRuns.get(userId);
  if (runs) {
    for (const controller of runs) {
      controller.abort();
    }
    runs.clear();
    activeSupervisorRuns.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// /clear command
// ---------------------------------------------------------------------------

export async function handleClearCommand(userId: string, fromPhone: string): Promise<void> {
  log.info('/clear command received', { userId });

  // Abort any in-flight supervisor runs so they don't send SMS after clear
  abortAllSupervisorRuns(userId);

  // Clear SMS session history under the per-user commit lock, so a supervisor
  // on another instance that already passed its seq gate finishes its commit
  // before the clear supersedes it.
  await withCommitLock(userId, () => repo.clearSmsSession(userId));

  // Find and terminate all active SMS-source agents for this user
  const activeAgents = await repo.findActiveSmsAgents(userId);

  if (activeAgents.length > 0) {
    log.info('Terminating active SMS agents on /clear', {
      userId,
      agentCount: activeAgents.length,
      agentIds: activeAgents.map((a) => a.id),
    });

    for (const agent of activeAgents) {
      // Same canonical kill as DELETE /api/agents/:id (UI Archive) / SMS kill_agent.
      await deleteAgentRecursive(agent.id, {
        terminateReason: 'Session cleared by user via /clear',
      });
    }
  }

  await sendSms(fromPhone, 'Session cleared.');
}

// ---------------------------------------------------------------------------
// SMS Supervisor routing (main path)
// ---------------------------------------------------------------------------

/* c8 ignore start -- routeToSupervisor delegates to handleSmsSupervisorMessage (excluded smsSupervisor module) */
export async function routeToSupervisor(
  userId: string,
  message: ParsedSurgeMessage,
  requestStart: number
): Promise<void> {
  const { fromPhone, messageBody, attachments, messageId } = message;
  // Persist first, before any asynchronous supervisor work. Advancing the
  // sequence and appending this exact inbound record happen atomically.
  const persistedInbound = [
    messageBody,
    attachments.length > 0 ? `[${attachments.length} attachment(s)]` : '',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  const mySeq = await recordInboundSms(userId, persistedInbound, messageId);

  log.info('Routing to SMS Supervisor', {
    userId,
    messageLength: messageBody.length,
    attachmentCount: attachments.length,
    mySeq,
  });

  // Run async — don't block the webhook response.
  // The supervisor sends its response via Surge API.
  const abortController = registerSupervisorRun(userId);

  handleSmsSupervisorMessage({
    userId,
    phoneNumber: fromPhone,
    inboundMessage: messageBody,
    inboundMessageId: messageId,
    mySeq,
    inboundAlreadyPersisted: true,
    attachments,
    abortSignal: abortController.signal,
  })
    .then((result) => {
      log.info('Supervisor completed', {
        userId,
        mySeq,
        committed: result.committed,
        responseLength: result.responseText.length,
        toolsExecuted: result.toolsExecuted,
        totalDurationMs: Date.now() - requestStart,
      });
    })
    .catch((error) =>
      handleSupervisorFailure({ userId, fromPhone, mySeq, requestStart, abortController, error })
    )
    .finally(() => {
      unregisterSupervisorRun(userId, abortController);
    });
}

interface SupervisorFailureInput {
  userId: string;
  fromPhone: string;
  mySeq: number;
  requestStart: number;
  abortController: AbortController;
  error: unknown;
}

/**
 * SMS supervisor failure handler: log → alert #errors → best-effort fallback SMS
 * (gated on sequence so a superseded run stays silent). Aborted runs (e.g.
 * /clear) are treated as clean, not failures.
 */
async function handleSupervisorFailure(input: SupervisorFailureInput): Promise<void> {
  const { userId, fromPhone, mySeq, requestStart, abortController, error } = input;

  if (abortController.signal.aborted) {
    log.info('Supervisor aborted (session cleared)', {
      userId,
      mySeq,
      durationMs: Date.now() - requestStart,
    });
    return;
  }

  log.error('Supervisor failed', {
    userId,
    mySeq,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    durationMs: Date.now() - requestStart,
  });

  alertError({
    source: 'sms',
    message: error instanceof Error ? error.message : String(error),
    userId,
    stack: error instanceof Error ? error.stack : undefined,
    context: { mySeq },
  });

  // Send error SMS as fallback. Gate on the same seq the run captured: if a
  // newer SMS (or a /clear, on any instance) arrived during our run, stay
  // silent. Check and send under the per-user commit lock so a /clear cannot
  // land between them.
  try {
    await withCommitLock(userId, async () => {
      const currentSeq = await repo.getInboundSeq(userId);
      if ((currentSeq ?? 0) > mySeq) {
        log.info('Error path: seq advanced, suppressing fallback SMS', {
          userId,
          mySeq,
          currentSeq,
        });
        return;
      }
      await sendSms(fromPhone, SUPERVISOR_FALLBACK_MESSAGE);
    });
  } catch (smsError) {
    log.error('Failed to send error SMS', {
      error: smsError instanceof Error ? smsError.message : String(smsError),
    });
  }
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Outbound delivery-status receipts (message.sent / delivered / failed)
// ---------------------------------------------------------------------------

/**
 * Record a Surge outbound delivery-status event. Logs every terminal status and
 * loudly alerts when the carrier FILTERED a message (`message_filtered`) — the
 * silent failure that dropped every link-bearing SMS. Other failure reasons
 * (opted_out, invalid_mobile_number) are expected per-recipient outcomes and are
 * logged, not alerted, so Slack does not firehose at scale.
 *
 * Prereq: Surge must be subscribed to these events in the dashboard webhook
 * config (the API exposes no webhook-subscription endpoint). Until then we
 * receive only message.received and this never fires.
 */
export function recordSurgeDeliveryStatus(event: SurgeDeliveryStatusEvent): void {
  const toPreview =
    event.toPhone !== null && event.toPhone !== ''
      ? event.toPhone.substring(0, 7) + '****'
      : 'unknown';
  log.info('SMS delivery status', {
    type: event.type,
    messageId: event.messageId,
    to: toPreview,
    failureReason: event.failureReason,
    failedAt: event.failedAt,
    bodyPreview: event.bodyPreview?.substring(0, 100),
  });

  if (event.type !== 'message.failed') return;

  log.error('Outbound SMS failed to deliver', {
    messageId: event.messageId,
    failureReason: event.failureReason,
    to: toPreview,
    bodyPreview: event.bodyPreview?.substring(0, 100),
  });

  if (event.failureReason === 'message_filtered') {
    alertError({
      source: 'sms',
      message: `Outbound SMS carrier-filtered (message_filtered): message ${event.messageId}. A link/content deliverability regression is dropping messages.`,
      context: {
        messageId: event.messageId,
        failureReason: event.failureReason,
        bodyPreview: event.bodyPreview,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Main inbound handler (orchestrates all paths)
// ---------------------------------------------------------------------------

export interface InboundSmsInput {
  body: Record<string, unknown>;
  rawBody?: string;
  surgeSignatureHeader: string | undefined;
}

export interface InboundSmsResult {
  ok: true;
}

export async function handleInboundSms(input: InboundSmsInput): Promise<InboundSmsResult> {
  const requestStart = Date.now();

  const signingSecret = SURGE_SIGNING_SECRET;

  // Validate Surge signature in production
  if (signingSecret !== undefined && signingSecret !== '' && IS_PRODUCTION) {
    const rawBody = input.rawBody ?? JSON.stringify(input.body);
    if (!validateSurgeSignature(input.surgeSignatureHeader, rawBody, signingSecret)) {
      log.error('Invalid Surge signature', {
        headers:
          input.surgeSignatureHeader !== undefined && input.surgeSignatureHeader !== ''
            ? ['surge-signature']
            : [],
      });
      throw new InvalidSignatureError();
    }
  }

  // Log raw payload shape on every request so we can verify Surge's format
  const body = input.body;
  const conversation = body?.conversation as Record<string, unknown> | undefined;
  const contact = conversation?.contact as Record<string, unknown> | undefined;
  log.info('Raw Surge payload', {
    keys: Object.keys(body),
    type: String(body?.type ?? ''),
    hasBody: String('body' in body),
    hasConversation: String('conversation' in body),
    conversationKeys: conversation !== undefined ? Object.keys(conversation) : [],
    contactKeys: contact !== undefined ? Object.keys(contact) : [],
    raw: JSON.stringify(body).substring(0, 500),
  });

  // Delivery-status receipts (message.sent/delivered/failed) report the fate of
  // an OUTBOUND message. Handle and acknowledge them here — they are not inbound
  // user text and must never reach the supervisor. This is the only channel
  // through which we learn a message was carrier-filtered.
  const deliveryEvent = parseSurgeDeliveryEvent(body);
  if (deliveryEvent) {
    recordSurgeDeliveryStatus(deliveryEvent);
    return { ok: true };
  }

  const parsed = parseSurgePayload(input.body);

  log.info('Inbound SMS received', {
    from: (parsed?.fromPhone?.substring(0, 7) ?? '') + '****',
    bodyLength: parsed?.messageBody.length,
    bodyPreview: parsed?.messageBody.substring(0, 100),
    rawType: String(body?.type ?? ''),
  });

  if (!parsed) {
    log.warn('Could not parse Surge payload', {
      hasBody: String(body.body !== undefined),
      hasConversation: String(body.conversation !== undefined),
      keys: Object.keys(body),
    });
    throw new InvalidPayloadError();
  }

  const { fromPhone, messageBody } = parsed;

  // Resolve (or provision) the user. An inbound SMS proves possession of the
  // number, so a first-time texter is onboarded SILENTLY — no OTP, no signup
  // wall, no welcome nag — then handled exactly like a known user. This replaces
  // the old "please sign up at roselabs.ai first" dead-end.
  const { user, created } = await repo.provisionUserByPhone(fromPhone);

  if (created) {
    log.info('Provisioned new SMS user (first contact)', {
      userId: user.userId,
      phone: fromPhone?.substring(0, 7) + '****',
    });
    // Free-tier starting credit, mirroring web signup. Non-fatal: the user can
    // still be served if credit creation fails.
    try {
      await createSignupBonusCredit(user.userId);
    } catch (error) {
      log.error('Failed to create signup bonus credit for provisioned user', {
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    log.info('User found', {
      userId: user.userId,
      phone: fromPhone?.substring(0, 7) + '****',
    });
  }

  // FAST PATH: /clear command (reset SMS session)
  if (messageBody.toLowerCase() === '/clear') {
    await handleClearCommand(user.userId, fromPhone);
    return { ok: true };
  }

  // MAIN PATH: Route through SMS Supervisor Agent.
  // Await long enough to atomically bump `lastInboundSeq` so the run captures
  // the right `mySeq` before the next inbound SMS can race. The supervisor
  // itself continues async — the webhook still returns 200 promptly.
  await routeToSupervisor(user.userId, parsed, requestStart);

  return { ok: true };
}
