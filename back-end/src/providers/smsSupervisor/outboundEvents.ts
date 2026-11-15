/**
 * SMS Outbound Lifecycle Events
 *
 * Template-based outbound SMS for agent lifecycle events, triggered directly
 * by the agent workflow. Rejected messages use a bounded model correction loop.
 *
 * Fires for ROOT agents of any source (SMS, web, mac-app, API). Benchmark/eval
 * runs are suppressed centrally in the send-sms dispatcher (Agent.isBenchmark).
 * Events with a run link use the per-agent deep link from getAgentUrl.
 * Completion is narrower: it is sent only for agents the SMS/WhatsApp agent
 * interacted with, so every delivered relay below (question, approval, sign-in,
 * AgentCard setup, budget limit) records that interaction. The kickoff receipt
 * does not (see providers/messagingAgentInteraction.ts).
 */

import { createLogger } from '../logger';
import { sendSms, sendMms, getUserPhone } from '../smsQueue';
import { sendOnChannel, type SupervisorChannel } from './channelDelivery';
import { isEmojiOnlyMessage } from './emoji';
import { SMS_MAX_BODY_CHARACTERS } from '../smsDeliveryContract';
import {
  approvalNotificationContent,
  deliverNotificationCard,
  plannerNotificationContent,
} from './notificationCards';
import { markWhatsAppReachable, markWhatsAppUnreachable } from '../whatsappReachability';
import { ROSE_LABS_URL, SMS_TEMPLATES, getAgentUrl } from '../smsTemplates';
import { rehostMmsAttachmentUrl } from './mmsAttachment';
import { appendLifecycleSms } from './sessionStore';
import { recordMessagingAgentInteraction } from '../messagingAgentInteraction';
import {
  deliverNotificationMessage,
  MAX_NOTIFICATION_CORRECTIONS,
  NotificationDeliveryError,
  type NotificationContent,
} from './notificationDelivery';
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
// Superset of SmsSendResult that also carries WhatsApp's `recipientUnreachable`.
type ChannelSendResult = Awaited<ReturnType<typeof sendOnChannel>>;

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

/**
 * Deliver one lifecycle message across every mirrored channel, updating WhatsApp
 * reachability from the result (stop mirroring on undeliverable, re-enable on a
 * successful send). Returns the SMS result (or the first channel's) as the
 * transcript anchor so a mirrored send appends the user's thread exactly once.
 */
async function deliverAcrossChannels(
  userId: string,
  phone: string,
  notification: NotificationContent,
  channels: readonly SupervisorChannel[],
  send: (channel: SupervisorChannel, message: string) => Promise<ChannelSendResult>,
  options?: SmsArchiveOptions,
  channelNotifications: Partial<Record<SupervisorChannel, NotificationContent>> = {}
): Promise<ChannelSendResult & { message: string }> {
  let anchor: (ChannelSendResult & { message: string }) | undefined;
  let firstSuccess: (ChannelSendResult & { message: string }) | undefined;
  let channelMessage = notification.message;
  const correctionBudget = { remaining: MAX_NOTIFICATION_CORRECTIONS };
  let allFailuresDefinitive = true;
  for (const channel of channels) {
    const override = channelNotifications[channel];
    const content = override ?? { ...notification, message: channelMessage };
    const result = await deliverNotificationMessage({
      channel,
      message: content.message,
      requiredLinks: content.requiredLinks,
      preserveText: content.preserveText,
      agentId: options?.archiveRootAgentId,
      userId,
      eventType: options?.archiveContext?.event_type,
      correctionBudget,
      send: (candidate) => send(channel, candidate),
    });
    // Keep the full receipt/instructions and the transcript's original text
    // anchor. A card is a separate Linq message, never mixed with text/media.
    // Failure of this optional companion cannot retry an accepted notification.
    if (result.success && channel === 'SMS' && notification.card) {
      await deliverNotificationCard(phone, notification.card, result, options);
    }
    if (channel === 'WHATSAPP') {
      if (result.recipientUnreachable === true) await markWhatsAppUnreachable(userId);
      else if (result.success) await markWhatsAppReachable(userId);
    }
    if (result.success && firstSuccess === undefined) firstSuccess = result;
    if (!result.success && result.definitiveFailure !== true) allFailuresDefinitive = false;
    if (result.success && override === undefined) channelMessage = result.message;
    if (channel === 'SMS' || anchor === undefined) anchor = result;
  }
  // A mirrored send succeeded if ANY channel delivered — so a successful result
  // anchors the transcript append + completion outcome even when another channel
  // (e.g. SMS) failed. Fall back to the SMS/first result when all channels fail.
  if (firstSuccess) return firstSuccess;
  if (anchor) return { ...anchor, definitiveFailure: allFailuresDefinitive };
  return { success: false, error: 'no delivery channels', message: notification.message };
}

async function sendLifecycleSms(
  userId: string,
  phone: string,
  notification: NotificationContent,
  options?: SmsArchiveOptions,
  channels: readonly SupervisorChannel[] = ['SMS'],
  channelNotifications: Partial<Record<SupervisorChannel, NotificationContent>> = {}
): Promise<SmsSendResult> {
  const result = await deliverAcrossChannels(
    userId,
    phone,
    notification,
    channels,
    (channel, candidate) =>
      sendOnChannel(channel, phone, candidate, {
        ...options,
        abortSignal: AbortSignal.timeout(30_000),
      }),
    options,
    channelNotifications
  );
  await recordLifecycleTurn(userId, result.message, result);
  return result;
}

async function sendLifecycleMms(
  userId: string,
  phone: string,
  notification: NotificationContent,
  mediaUrl: string,
  options?: SmsArchiveOptions,
  channels: readonly SupervisorChannel[] = ['SMS']
): Promise<SmsSendResult> {
  // WhatsApp Cloud API sends are text-only in v1 (media is a follow-up); the
  // message body already carries the deep link, so WhatsApp degrades to text
  // while SMS keeps the MMS attachment.
  const result = await deliverAcrossChannels(
    userId,
    phone,
    notification,
    channels,
    (channel, candidate) =>
      channel === 'WHATSAPP'
        ? sendOnChannel('WHATSAPP', phone, candidate, options)
        : sendMms(phone, candidate, mediaUrl, {
            ...options,
            abortSignal: AbortSignal.timeout(30_000),
          }),
    options
  );
  await recordLifecycleTurn(userId, result.message, result);
  return result;
}

function requireNotificationDelivery(result: SmsSendResult): void {
  if (!result.success) throw new NotificationDeliveryError(result);
}

const MAX_COMPLETION_OUTPUT_LINES = 6;

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
  outputs?: unknown,
  finalAnswer?: string
): string {
  if (finalAnswer !== undefined) return finalAnswer;
  const prefix = agentId.substring(0, 6);
  const url = getAgentUrl(agentId);
  const oneLineSummary = summary.replace(/\s+/g, ' ').trim();
  return SMS_TEMPLATES.agentCompleted(prefix, oneLineSummary, url, completionOutputLines(outputs));
}

/**
 * Notify user that a new agent has been started.
 */
export async function notifyAgentStarted(
  userId: string,
  agent: { id: string; goal: string; notificationMessage?: string },
  channels: SupervisorChannel[] = ['SMS']
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
  const message = SMS_TEMPLATES.agentStarted(prefix, agent.goal, url, agent.notificationMessage);

  const result = await sendLifecycleSms(
    userId,
    phone,
    {
      message,
      requiredLinks: [url],
      card: { url, title: 'Rose is working', subtitle: agent.goal },
    },
    {
      archiveRootAgentId: agent.id,
      archiveContext: { event_type: 'agent_started', user_id: userId },
    },
    channels
  );

  log.info('agentStarted SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    error: result.error,
    durationMs: Date.now() - startTime,
  });
  requireNotificationDelivery(result);
}

/**
 * Notify user of a planner message (question or FYI).
 */
export async function notifyPlannerMessage(
  userId: string,
  agent: { id: string },
  messageText: string,
  isQuestion: boolean,
  channels: SupervisorChannel[] = ['SMS']
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

  const result = await sendLifecycleSms(
    userId,
    phone,
    plannerNotificationContent(message, messageText, isQuestion),
    {
      archiveRootAgentId: agent.id,
      archiveContext: { event_type: 'planner_message', user_id: userId, is_question: isQuestion },
    },
    channels
  );

  log.info('plannerMessage SMS sent', {
    userId,
    agentPrefix: prefix,
    isQuestion,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
  requireNotificationDelivery(result);
  await recordMessagingAgentInteraction(agent.id, 'planner_message');
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
  metadata?: unknown,
  channels: SupervisorChannel[] = ['SMS'],
  onDeliveryAttempt?: () => void
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
  const approvalContent = approvalNotificationContent(message, agentUrl, question, !!paymentCard);

  const result = rehostedMediaUrl
    ? await sendLifecycleMms(
        userId,
        phone,
        approvalContent,
        rehostedMediaUrl,
        {
          archiveRootAgentId: agent.id,
          onDeliveryAttempt,
          archiveContext: {
            event_type: 'write_lock',
            user_id: userId,
            attention_request_id: attentionRequestId,
          },
        },
        channels
      )
    : await sendLifecycleSms(
        userId,
        phone,
        approvalContent,
        {
          archiveRootAgentId: agent.id,
          onDeliveryAttempt,
          archiveContext: {
            event_type: 'write_lock',
            user_id: userId,
            attention_request_id: attentionRequestId,
          },
        },
        channels
      );

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
  requireNotificationDelivery(result);
  await recordMessagingAgentInteraction(agent.id, 'write_lock');
}

/**
 * Notify user of an authentication handoff request.
 */
export async function notifyAuthAssistance(
  userId: string,
  agent: { id: string },
  authRealm: string,
  browserSessionId?: string | null,
  attentionRequestId?: string | null
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
  const url = getAgentUrl(agent.id, browserSessionId, attentionRequestId);
  const message = SMS_TEMPLATES.authAssistance(prefix, authRealm, url);

  const result = await sendLifecycleSms(
    userId,
    phone,
    {
      message,
      requiredLinks: [url],
      card: { url, title: 'Sign in to continue', subtitle: authRealm, button: 'Sign in' },
    },
    {
      archiveRootAgentId: agent.id,
      archiveContext: {
        event_type: 'auth_assistance',
        user_id: userId,
        browser_session_id: browserSessionId ?? null,
        attention_request_id: attentionRequestId ?? null,
      },
    }
  );

  log.info('authAssistance SMS sent', {
    userId,
    agentPrefix: prefix,
    authRealm,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
  requireNotificationDelivery(result);
  await recordMessagingAgentInteraction(agent.id, 'auth_assistance');
}

/**
 * Notify user that AgentCard setup is required before issuing a payment card.
 */
export async function notifyAgentCardSetup(
  userId: string,
  agent: { id: string },
  setupUrl: string,
  channels: SupervisorChannel[] = ['SMS']
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
  const result = await sendLifecycleSms(
    userId,
    phone,
    {
      message,
      requiredLinks: [setupUrl || ROSE_LABS_URL],
      card: {
        url: setupUrl || ROSE_LABS_URL,
        title: 'Finish AgentCard setup',
        subtitle: 'Complete your existing card setup so Rose can continue.',
        button: 'Set up card',
      },
    },
    undefined,
    channels
  );

  log.info('agentCardSetup SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
  requireNotificationDelivery(result);
  await recordMessagingAgentInteraction(agent.id, 'agentcard_setup');
}

/**
 * Notify user that an agent has completed.
 */
export async function notifyCompletion(
  userId: string,
  agent: { id: string },
  summary: string,
  outputs?: unknown,
  channels: SupervisorChannel[] = ['SMS'],
  finalAnswer?: string
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
  const message = buildCompletionSmsBody(agent.id, summary, outputs, finalAnswer);
  const smsFallback =
    finalAnswer !== undefined &&
    (finalAnswer.length > SMS_MAX_BODY_CHARACTERS || isEmojiOnlyMessage(finalAnswer))
      ? {
          message: `Your result is ready: ${getAgentUrl(agent.id)}`,
          requiredLinks: [getAgentUrl(agent.id)],
          preserveText: true,
        }
      : undefined;

  const result = await sendLifecycleSms(
    userId,
    phone,
    {
      message,
      requiredLinks: finalAnswer === undefined ? [getAgentUrl(agent.id)] : [],
      preserveText: finalAnswer !== undefined,
      card: { url: getAgentUrl(agent.id), title: 'Rose finished the task', subtitle: summary },
    },
    {
      archiveRootAgentId: agent.id,
      archiveContext: { event_type: 'completion', user_id: userId },
    },
    channels,
    smsFallback ? { SMS: smsFallback } : {}
  );

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
  agent: { id: string; goal: string; treeCostCents: number; priceLimitCents: number },
  channels: SupervisorChannel[] = ['SMS']
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
  const agentUrl = getAgentUrl(agent.id);
  const message = `${SMS_TEMPLATES.costLimit(
    prefix,
    taskLabel,
    agent.treeCostCents,
    agent.priceLimitCents
  )}\n${agentUrl}`;

  const result = await sendLifecycleSms(
    userId,
    phone,
    {
      message,
      requiredLinks: [agentUrl],
      card: { url: agentUrl, title: 'Rose reached the task budget', subtitle: taskLabel },
    },
    {
      archiveRootAgentId: agent.id,
      archiveContext: { event_type: 'cost_limit', user_id: userId },
    },
    channels
  );

  log.info('costLimit SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
  requireNotificationDelivery(result);
  await recordMessagingAgentInteraction(agent.id, 'cost_limit');
}
