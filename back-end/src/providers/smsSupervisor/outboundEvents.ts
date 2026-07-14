/**
 * SMS Outbound Lifecycle Events
 *
 * Template-based outbound SMS for agent lifecycle events. No LLM involved —
 * these are triggered directly by the agent workflow for speed.
 *
 * Only fires for SMS-source root agents.
 */

import { createLogger } from '../logger';
import { sendSms, sendMms, getUserPhone } from '../smsQueue';
import { SMS_TEMPLATES, getAgentUrl } from '../smsTemplates';
import { getSignedUrl, uploadToStorage } from '../storage';

const log = createLogger('OutboundEvents');
const MAX_MMS_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MMS_ATTACHMENT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

interface WriteLockNotificationMedia {
  url?: unknown;
  alt?: unknown;
  kind?: unknown;
}

interface WriteLockNotificationItem {
  title?: unknown;
  price?: unknown;
  quantity?: unknown;
  description?: unknown;
  rating?: unknown;
  review_count?: unknown;
  image_url?: unknown;
}

interface WriteLockNotificationPurchase {
  items?: unknown;
  totals?: unknown;
}

interface WriteLockNotificationService {
  name?: unknown;
  domain?: unknown;
  url?: unknown;
}

interface WriteLockNotification {
  trigger_type?: unknown;
  action?: unknown;
  service?: WriteLockNotificationService;
  media?: unknown;
  purchase?: WriteLockNotificationPurchase;
}

interface WriteLockMetadata {
  writeLockNotification?: WriteLockNotification | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function displayServiceName(service: WriteLockNotificationService | null): string {
  const name = asString(service?.name);
  if (name) {
    return name.replace(/\b(?:www\.)?([a-z0-9-]+)\.(?:com|co|net|org|io|ai)\b/gi, '$1');
  }

  const domain = asString(service?.domain);
  if (!domain) {
    return 'the site';
  }

  const withoutWww = domain.replace(/^www\./i, '');
  const label = withoutWww.split('.')[0] || withoutWww;
  return label ? label[0].toUpperCase() + label.slice(1) : 'the site';
}

function sanitizeSmsText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, '')
    .replace(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}\b/gi, '')
    .replace(/\b([a-z0-9-]+)\.(?:com|co|net|org|io|ai)\b/gi, (_match, label: string) => {
      return label ? label[0].toUpperCase() + label.slice(1) : '';
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

function getWriteLockNotification(metadata: unknown): WriteLockNotification | null {
  const metadataRecord = asRecord(metadata) as WriteLockMetadata | null;
  const notification = metadataRecord?.writeLockNotification ?? null;
  return asRecord(notification) as WriteLockNotification | null;
}

function getWriteLockMediaUrl(notification: WriteLockNotification | null): string | null {
  const media = Array.isArray(notification?.media) ? notification.media : [];
  const firstImage = media
    .map((entry) => asRecord(entry) as WriteLockNotificationMedia | null)
    .find((entry) => asString(entry?.url) !== null);
  const mediaUrl = asString(firstImage?.url);
  if (mediaUrl) {
    return mediaUrl;
  }

  const firstItemImage = getWriteLockItems(notification)
    .map((item) => asString(item.image_url))
    .find((url) => url !== null);
  return firstItemImage ?? null;
}

function getWriteLockItems(
  notification: WriteLockNotification | null
): WriteLockNotificationItem[] {
  const items = Array.isArray(notification?.purchase?.items) ? notification.purchase.items : [];
  return items
    .map((entry) => asRecord(entry) as WriteLockNotificationItem | null)
    .filter((entry): entry is WriteLockNotificationItem => entry !== null);
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
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

function formatWriteLockNotificationBody(
  notification: WriteLockNotification | null,
  fallbackQuestion: string
): string {
  if (!notification) {
    return SMS_TEMPLATES.writeLock('', fallbackQuestion);
  }

  const service = asRecord(notification.service) as WriteLockNotificationService | null;
  const serviceName = displayServiceName(service);
  const lines = [`Approval needed`, `Rose needs your approval for ${serviceName} checkout.`];
  const items = getWriteLockItems(notification);

  if (items.length === 1) {
    const item = items[0];
    const title = asString(item.title);
    if (title) lines.push('', `Item: ${sanitizeSmsText(title)}`);
    const price = asString(item.price);
    if (price) lines.push(`Price: ${price}`);
    const quantity = asString(item.quantity);
    if (quantity) lines.push(`Qty: ${quantity}`);
    const description = asString(item.description);
    if (description) {
      const sanitizedDescription = sanitizeSmsText(description);
      if (sanitizedDescription) {
        lines.push(`Description: ${sanitizedDescription}`);
      }
    }
    const rating = asString(item.rating);
    if (rating) lines.push(`Rating: ${rating}`);
    const reviewCount = asString(item.review_count);
    if (reviewCount) lines.push(`Reviews: ${reviewCount}`);
  } else if (items.length > 1) {
    lines.push('', `Items (${String(items.length)}):`);
    for (const [index, item] of items.slice(0, 6).entries()) {
      const title = sanitizeSmsText(asString(item.title) ?? `Item ${String(index + 1)}`);
      const price = asString(item.price);
      const quantity = asString(item.quantity);
      lines.push(
        `${String(index + 1)}. ${title}${price ? ` - ${price}` : ''}${quantity ? ` x${quantity}` : ''}`
      );
    }
    if (items.length > 6) {
      lines.push(`...and ${String(items.length - 6)} more`);
    }
  }

  const totals = asRecord(notification.purchase?.totals);
  const total = asString(totals?.total);
  const subtotal = asString(totals?.subtotal);
  const tax = asString(totals?.tax);
  if (subtotal || tax || total) {
    lines.push('');
    if (subtotal) lines.push(`Subtotal: ${subtotal}`);
    if (tax) lines.push(`Tax: ${tax}`);
    if (total) lines.push(`Total: ${total}`);
  }

  return truncateText(lines.map((line) => sanitizeSmsText(line)).join('\n'), 900);
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

  const result = await sendSms(phone, message, {
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

  const result = await sendSms(phone, message, {
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

  const prefix = agent.id.substring(0, 6);
  const notification = getWriteLockNotification(metadata);
  const message = notification
    ? formatWriteLockNotificationBody(notification, question)
    : SMS_TEMPLATES.writeLock(prefix, question);
  const mediaUrl = getWriteLockMediaUrl(notification);
  const rehostedMediaUrl = mediaUrl ? await rehostMmsAttachmentUrl(userId, mediaUrl) : null;

  const result = rehostedMediaUrl
    ? await sendMms(phone, message, rehostedMediaUrl, {
        archiveRootAgentId: agent.id,
        archiveContext: {
          event_type: 'write_lock',
          user_id: userId,
          attention_request_id: attentionRequestId,
        },
      })
    : await sendSms(phone, message, {
        archiveRootAgentId: agent.id,
        archiveContext: {
          event_type: 'write_lock',
          user_id: userId,
          attention_request_id: attentionRequestId,
        },
      });

  log.info('writeLock notification sent', {
    userId,
    agentPrefix: prefix,
    attentionRequestId,
    channel: rehostedMediaUrl ? 'mms' : 'sms',
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

  const result = await sendSms(phone, message, {
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
  const result = await sendSms(phone, message);

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
  summary: string
): Promise<void> {
  const startTime = Date.now();

  log.info('notifyCompletion', {
    userId,
    agentId: agent.id,
    summaryLength: summary.length,
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    log.info('No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const url = getAgentUrl(agent.id);
  const message = SMS_TEMPLATES.agentCompleted(prefix, summary, url);

  const result = await sendSms(phone, message, {
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

  const result = await sendSms(phone, message, {
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
