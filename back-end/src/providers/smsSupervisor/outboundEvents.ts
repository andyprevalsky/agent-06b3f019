/**
 * SMS Outbound Lifecycle Events
 *
 * Template-based outbound SMS for agent lifecycle events. No LLM involved —
 * these are triggered directly by the agent workflow for speed.
 *
 * Fires for ROOT agents of any source (SMS, web, mac-app, API). Benchmark/eval
 * runs are suppressed centrally in the send-sms dispatcher (Agent.isBenchmark).
 * Every message carries the per-agent deep link via getAgentUrl.
 */

import { createLogger } from '../logger';
import { sendSms, sendMms, getUserPhone } from '../smsQueue';
import { SMS_TEMPLATES, getAgentUrl } from '../smsTemplates';
import { getSignedUrl, uploadToStorage } from '../storage';
import { appendLifecycleSms } from './sessionStore';
import {
  formatPaymentApprovalBody,
  getPaymentCardMediaUrl,
  getRequestPaymentCard,
  getWriteLockMediaUrl,
  getWriteLockNotification,
  sanitizeSmsText,
  truncateText,
} from './writeLockBody';

const log = createLogger('OutboundEvents');

type SmsArchiveOptions = Parameters<typeof sendSms>[2];
type SmsSendResult = Awaited<ReturnType<typeof sendSms>>;

/**
 * Record a delivered lifecycle SMS on the user's supervisor transcript.
 *
 * These messages arrive on the same thread the SMS supervisor talks on, so the
 * supervisor must see them — otherwise it re-narrates progress the user was
 * already told about by the agent itself. Best-effort: the SMS is already out,
 * so a transcript failure is logged, never thrown.
 */
async function recordLifecycleTurn(
  userId: string,
  message: string,
  result: SmsSendResult
): Promise<void> {
  if (!result.success) return;
  try {
    await appendLifecycleSms(userId, message, result.messageSid);
  } catch (error) {
    log.error('Lifecycle SMS delivered but transcript append failed', {
      userId,
      messageSid: result.messageSid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sendLifecycleSms(
  userId: string,
  phone: string,
  message: string,
  options?: SmsArchiveOptions
): Promise<SmsSendResult> {
  const result = await sendSms(phone, message, options);
  await recordLifecycleTurn(userId, message, result);
  return result;
}

async function sendLifecycleMms(
  userId: string,
  phone: string,
  message: string,
  mediaUrl: string,
  options?: SmsArchiveOptions
): Promise<SmsSendResult> {
  const result = await sendMms(phone, message, mediaUrl, options);
  await recordLifecycleTurn(userId, message, result);
  return result;
}

const MAX_MMS_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MMS_ATTACHMENT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;
const MAX_COMPLETION_OUTPUT_LINES = 6;

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function completionOutputLines(outputs: unknown): string[] {
  if (!Array.isArray(outputs)) return [];

  return outputs
    .flatMap((entry): string[] => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
      const output = entry as Record<string, unknown>;
      if (typeof output.key !== 'string' || output.key.trim() === '') return [];

      const labelSource =
        typeof output.label === 'string' && output.label.trim() !== '' ? output.label : output.key;
      const label = labelSource
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase());
      let value: string;
      if (typeof output.value === 'string') {
        value = output.value;
      } else if (
        typeof output.value === 'number' ||
        typeof output.value === 'boolean' ||
        typeof output.value === 'bigint'
      ) {
        value = String(output.value);
      } else {
        try {
          value = JSON.stringify(output.value) ?? String(output.value);
        } catch {
          value = String(output.value);
        }
      }
      const oneLineValue = truncateText(value.replace(/\s+/g, ' ').trim(), 160);
      return oneLineValue ? [`${label}: ${oneLineValue}`] : [];
    })
    .slice(0, MAX_COMPLETION_OUTPUT_LINES);
}

export function buildCompletionSmsBody(
  agentId: string,
  summary: string,
  outputs?: unknown
): string {
  const prefix = agentId.substring(0, 6);
  const url = getAgentUrl(agentId);
  const oneLineSummary = summary.replace(/\s+/g, ' ').trim();
  return SMS_TEMPLATES.agentCompleted(prefix, oneLineSummary, url, completionOutputLines(outputs));
}

async function rehostMmsAttachmentUrl(userId: string, mediaUrl: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(mediaUrl, {
      headers: {
        accept: 'image/*,*/*;q=0.8',
        'user-agent': 'Rose/1.0 MMS attachment fetcher',
      },
    });
  } catch (error) {
    log.warn('Failed to fetch MMS attachment before sending', {
      userId,
      mediaUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!response.ok) {
    log.warn('MMS attachment URL was not fetchable', {
      userId,
      mediaUrl,
      status: response.status,
    });
    return null;
  }

  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    log.warn('MMS attachment URL did not return an image', {
      userId,
      mediaUrl,
      mimeType,
    });
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_MMS_ATTACHMENT_BYTES) {
    log.warn('MMS attachment size is invalid', {
      userId,
      mediaUrl,
      sizeBytes: buffer.length,
      maxBytes: MAX_MMS_ATTACHMENT_BYTES,
    });
    return null;
  }

  const filename = `write-lock-${Date.now()}.${extensionFromMimeType(mimeType)}`;
  const { storage_path: storagePath } = await uploadToStorage(userId, buffer, filename, mimeType);
  return getSignedUrl(storagePath, MMS_ATTACHMENT_SIGNED_URL_TTL_SECONDS);
}

/**
 * Notify user that a new agent has been started.
 */
export async function notifyAgentStarted(
  userId: string,
  agent: { id: string; goal: string }
): Promise<void> {
  const startTime = Date.now();

  log.info('notifyAgentStarted', {
    userId,
    agentId: agent.id,
    goalPreview: agent.goal.substring(0, 80),
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    log.info('No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const url = getAgentUrl(agent.id);
  const message = SMS_TEMPLATES.agentStarted(prefix, agent.goal, url);

  const result = await sendLifecycleSms(userId, phone, message, {
    archiveRootAgentId: agent.id,
    archiveContext: { event_type: 'agent_started', user_id: userId },
  });

  log.info('agentStarted SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    error: result.error,
    durationMs: Date.now() - startTime,
  });
}

/**
 * Notify user of a planner message (question or FYI).
 */
export async function notifyPlannerMessage(
  userId: string,
  agent: { id: string },
  messageText: string,
  isQuestion: boolean
): Promise<void> {
  const startTime = Date.now();

  log.info('notifyPlannerMessage', {
    userId,
    agentId: agent.id,
    isQuestion,
    messageLength: messageText.length,
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    log.info('No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const message = isQuestion
    ? SMS_TEMPLATES.plannerQuestion(prefix, messageText)
    : SMS_TEMPLATES.plannerFyi(prefix, messageText);

  const result = await sendLifecycleSms(userId, phone, message, {
    archiveRootAgentId: agent.id,
    archiveContext: { event_type: 'planner_message', user_id: userId, is_question: isQuestion },
  });

  log.info('plannerMessage SMS sent', {
    userId,
    agentPrefix: prefix,
    isQuestion,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
}

/**
 * Write-lock outbound path:
 * request_user_approval_direct(metadata.writeLockNotification)
 *   -> /api/send-sms/notify write_lock payload
 *   -> notifyWriteLock formats plain text and sends MMS when media exists
 *   -> iPhone Messages renders body + attached product/summary image.
 */
export async function notifyWriteLock(
  userId: string,
  agent: { id: string },
  question: string,
  attentionRequestId: string,
  _workflowId: string,
  metadata?: unknown
): Promise<void> {
  const startTime = Date.now();

  log.info('notifyWriteLock', {
    userId,
    agentId: agent.id,
    attentionRequestId,
    questionPreview: question.substring(0, 100),
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    log.info('No phone for user, skipping', { userId });
    return;
  }

  const notification = getWriteLockNotification(metadata);
  const paymentCard = getRequestPaymentCard(metadata);
  const agentUrl = getAgentUrl(agent.id);
  const message = formatPaymentApprovalBody(paymentCard, notification, question, agentUrl);
  const mediaUrl = getWriteLockMediaUrl(notification) ?? getPaymentCardMediaUrl(paymentCard);
  const rehostedMediaUrl = mediaUrl ? await rehostMmsAttachmentUrl(userId, mediaUrl) : null;

  const result = rehostedMediaUrl
    ? await sendLifecycleMms(userId, phone, message, rehostedMediaUrl, {
        archiveRootAgentId: agent.id,
        archiveContext: {
          event_type: 'write_lock',
          user_id: userId,
          attention_request_id: attentionRequestId,
        },
      })
    : await sendLifecycleSms(userId, phone, message, {
        archiveRootAgentId: agent.id,
        archiveContext: {
          event_type: 'write_lock',
          user_id: userId,
          attention_request_id: attentionRequestId,
        },
      });

  log.info('writeLock notification sent', {
    userId,
    agentPrefix: agent.id.substring(0, 6),
    attentionRequestId,
    channel: rehostedMediaUrl ? 'mms' : 'sms',
    hasPaymentCard: paymentCard !== null,
    hasStructuredNotification: notification !== null,
    hadOriginalMediaUrl: mediaUrl !== null,
    rehostedMedia: rehostedMediaUrl !== null,
    success: result.success,
    messageSid: result.messageSid,
    error: result.error,
    durationMs: Date.now() - startTime,
  });
}

/**
 * Notify user of an authentication handoff request.
 */
export async function notifyAuthAssistance(
  userId: string,
  agent: { id: string },
  authRealm: string,
  browserSessionId?: string | null
): Promise<void> {
  const startTime = Date.now();

  log.info('notifyAuthAssistance', {
    userId,
    agentId: agent.id,
    authRealm,
    browserSessionId,
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    log.info('No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const url = getAgentUrl(agent.id, browserSessionId);
  const message = SMS_TEMPLATES.authAssistance(prefix, authRealm, url);

  const result = await sendLifecycleSms(userId, phone, message, {
    archiveRootAgentId: agent.id,
    archiveContext: {
      event_type: 'auth_assistance',
      user_id: userId,
      browser_session_id: browserSessionId ?? null,
    },
  });

  log.info('authAssistance SMS sent', {
    userId,
    agentPrefix: prefix,
    authRealm,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
}

/**
 * Notify user that AgentCard setup is required before issuing a payment card.
 */
export async function notifyAgentCardSetup(
  userId: string,
  agent: { id: string },
  setupUrl: string
): Promise<void> {
  const startTime = Date.now();

  log.info('notifyAgentCardSetup', {
    userId,
    agentId: agent.id,
    hasSetupUrl: setupUrl.trim() !== '',
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    log.info('No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const message = SMS_TEMPLATES.agentCardSetup(prefix, setupUrl);
  const result = await sendLifecycleSms(userId, phone, message);

  log.info('agentCardSetup SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
}

/**
 * Notify user that an agent has completed.
 */
export async function notifyCompletion(
  userId: string,
  agent: { id: string },
  summary: string,
  outputs?: unknown
): Promise<{
  success: boolean;
  messageSid?: string;
  error?: string;
  definitiveFailure?: boolean;
  skipped?: boolean;
}> {
  const startTime = Date.now();

  log.info('notifyCompletion', {
    userId,
    agentId: agent.id,
    summaryLength: summary.length,
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    log.info('No phone for user, skipping', { userId });
    return { success: true, skipped: true };
  }

  const prefix = agent.id.substring(0, 6);
  const message = buildCompletionSmsBody(agent.id, summary, outputs);

  const result = await sendLifecycleSms(userId, phone, message, {
    archiveRootAgentId: agent.id,
    archiveContext: { event_type: 'completion', user_id: userId },
  });

  log.info('completion SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
  return result;
}

/**
 * Notify user that an agent hit its cost limit.
 */
export async function notifyCostLimit(
  userId: string,
  agent: { id: string; goal: string; treeCostCents: number; priceLimitCents: number }
): Promise<void> {
  const startTime = Date.now();

  log.info('notifyCostLimit', {
    userId,
    agentId: agent.id,
    treeCostCents: agent.treeCostCents,
    priceLimitCents: agent.priceLimitCents,
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    log.info('No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const taskLabel = truncateText(sanitizeSmsText(agent.goal), 80);
  const message = SMS_TEMPLATES.costLimit(
    prefix,
    taskLabel,
    agent.treeCostCents,
    agent.priceLimitCents
  );

  const result = await sendLifecycleSms(userId, phone, message, {
    archiveRootAgentId: agent.id,
    archiveContext: { event_type: 'cost_limit', user_id: userId },
  });

  log.info('costLimit SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
}
