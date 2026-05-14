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
import { SHORTCODE_REGEX, SURGE_SIGNING_SECRET, IS_PRODUCTION } from './config';
import type { ShortcodeResult } from './types';
import { validateSurgeSignature, parseSurgePayload } from './service.validation';
import { prisma } from '../../providers/database';
import { getTemporalClient } from '../../providers/temporal';
import { sendSms } from '../../providers/smsQueue';
import { SMS_TEMPLATES } from '../../providers/smsTemplates';
import { handleSmsSupervisorMessage } from '../../providers/smsSupervisor';
import { lookupAndConsumeShortcode } from '../../providers/smsSupervisor/shortcodes';
import { createLogger } from '../../providers/logger';

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
// Shortcode approval fast-path
// ---------------------------------------------------------------------------

export async function handleShortcodeApproval(
  messageBody: string,
  userId: string,
  fromPhone: string,
  requestStart: number
): Promise<boolean> {
  const shortcodeMatch = messageBody.match(SHORTCODE_REGEX);
  if (!shortcodeMatch) {
    return false;
  }

  const code = shortcodeMatch[1].toUpperCase();

  log.info('Shortcode approval attempt', {
    code,
    userId,
  });

  const shortcodeResult: ShortcodeResult | null = await lookupAndConsumeShortcode(code, userId);

  if (shortcodeResult) {
    log.info('Shortcode valid, approving', {
      code,
      attentionRequestId: shortcodeResult.attentionRequestId,
      agentId: shortcodeResult.agentId,
      workflowId: shortcodeResult.workflowId,
    });

    // Update the attention request
    await repo.updateAttentionRequest(
      shortcodeResult.attentionRequestId,
      'Approved via SMS shortcode'
    );

    // Signal the workflow
    /* c8 ignore start -- Temporal signal requires live Temporal server */
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(shortcodeResult.workflowId);
      await handle.signal(
        'receive_user_response',
        JSON.stringify({
          request_id: shortcodeResult.attentionRequestId,
          response: 'Approved via SMS shortcode',
        })
      );

      log.info('Signaled workflow with shortcode approval', {
        workflowId: shortcodeResult.workflowId,
        agentId: shortcodeResult.agentId,
      });
    } catch (error) {
      log.error('Failed to signal workflow for shortcode', {
        workflowId: shortcodeResult.workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    /* c8 ignore stop */

    // Send confirmation
    const agentPrefix = shortcodeResult.agentId.substring(0, 6);
    await sendSms(fromPhone, `[${agentPrefix}] Approved! Agent is continuing.`);

    log.info('Shortcode approval complete', {
      code,
      durationMs: Date.now() - requestStart,
    });

    return true;
  }

  // Invalid/expired shortcode
  log.info('Shortcode not found or expired', { code });
  await sendSms(fromPhone, `Code "${code}" not found or expired. Check the code and try again.`);
  return true;
}

// ---------------------------------------------------------------------------
// /clear command
// ---------------------------------------------------------------------------

export async function handleClearCommand(userId: string, fromPhone: string): Promise<void> {
  log.info('/clear command received', { userId });

  // Abort any in-flight supervisor runs so they don't send SMS after clear
  abortAllSupervisorRuns(userId);

  // Clear SMS session history
  await repo.clearSmsSession(userId);

  // Find and terminate all active SMS-source agents for this user
  const activeAgents = await repo.findActiveSmsAgents(userId);

  if (activeAgents.length > 0) {
    log.info('Terminating active SMS agents on /clear', {
      userId,
      agentCount: activeAgents.length,
      agentIds: activeAgents.map((a) => a.id),
    });

    /* c8 ignore start -- Temporal termination requires live Temporal server */
    const client = await getTemporalClient();

    for (const agent of activeAgents) {
      // Terminate Temporal workflow
      if (agent.temporalWorkflowId !== null && agent.temporalWorkflowId !== '') {
        try {
          const handle = client.workflow.getHandle(agent.temporalWorkflowId);
          await handle.terminate('Session cleared by user via /clear');
        } catch (error) {
          log.warn(`Failed to terminate workflow for agent ${agent.id}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Soft-delete the agent and all its children
      await repo.softDeleteAgentAndChildren(agent.id);
    }
    /* c8 ignore stop */
  }

  await sendSms(fromPhone, 'Session cleared.');
}

// ---------------------------------------------------------------------------
// SMS Supervisor routing (main path)
// ---------------------------------------------------------------------------

/* c8 ignore start -- routeToSupervisor delegates to handleSmsSupervisorMessage (excluded smsSupervisor module) */
export async function routeToSupervisor(
  userId: string,
  fromPhone: string,
  messageBody: string,
  requestStart: number
): Promise<void> {
  // Atomically bump the per-user inbound counter and capture the new value as
  // `mySeq`. The supervisor re-reads this value at attempt_completion time —
  // if a newer SMS has bumped it past `mySeq`, this run discards its queued
  // writes and stays silent. See providers/smsSupervisor/supervisorHandler.ts.
  const session = await prisma.smsSession.upsert({
    where: { userId },
    update: { lastInboundSeq: { increment: 1 } },
    create: { userId, messages: '[]', lastInboundSeq: 1 },
    select: { lastInboundSeq: true },
  });
  const mySeq = session.lastInboundSeq;

  log.info('Routing to SMS Supervisor', {
    userId,
    messageLength: messageBody.length,
    mySeq,
  });

  // Run async — don't block the webhook response.
  // The supervisor sends its response via Surge API.
  const abortController = registerSupervisorRun(userId);

  handleSmsSupervisorMessage({
    userId,
    phoneNumber: fromPhone,
    inboundMessage: messageBody,
    mySeq,
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
    .catch((error) => {
      // Don't send error SMS if we were aborted (e.g. by /clear)
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

      // Send error SMS as fallback. Gate on the same seq the run captured:
      // if a newer SMS arrived during our run, stay silent — the newer run
      // is responsible for the user reply.
      prisma.smsSession
        .findUnique({ where: { userId }, select: { lastInboundSeq: true } })
        .then(async (cur) => {
          if ((cur?.lastInboundSeq ?? 0) > mySeq) {
            log.info('Error path: seq advanced, suppressing fallback SMS', {
              userId,
              mySeq,
              currentSeq: cur?.lastInboundSeq,
            });
            return;
          }
          await sendSms(fromPhone, 'Sorry, something went wrong. Please try again.');
        })
        .catch((smsError) => {
          log.error('Failed to send error SMS', {
            error: smsError instanceof Error ? smsError.message : String(smsError),
          });
        });
    })
    .finally(() => {
      unregisterSupervisorRun(userId, abortController);
    });
}
/* c8 ignore stop */

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

  // Look up user by phone number
  const user = await repo.findUserByPhone(fromPhone);

  if (!user) {
    log.info('Unknown phone number', {
      phone: fromPhone?.substring(0, 7) + '****',
    });
    await sendSms(fromPhone, SMS_TEMPLATES.unknownPhone());
    return { ok: true };
  }

  log.info('User found', {
    userId: user.userId,
    phone: fromPhone?.substring(0, 7) + '****',
  });

  // FAST PATH: Shortcode approval (no LLM needed)
  const wasShortcode = await handleShortcodeApproval(
    messageBody,
    user.userId,
    fromPhone,
    requestStart
  );
  if (wasShortcode) {
    return { ok: true };
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
  await routeToSupervisor(user.userId, fromPhone, messageBody, requestStart);

  return { ok: true };
}
