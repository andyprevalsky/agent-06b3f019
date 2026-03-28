/**
 * SMS Outbound Lifecycle Events
 *
 * Template-based outbound SMS for agent lifecycle events. No LLM involved —
 * these are triggered directly by the agent workflow for speed.
 *
 * Only fires for SMS-source root agents.
 */

import { prisma } from '../database';
import { sendSms, getUserPhone } from '../smsQueue';
import { SMS_TEMPLATES, getAgentUrl } from '../smsTemplates';
import { createShortcode } from './shortcodes';

/**
 * Notify user that a new agent has been started.
 */
export async function notifyAgentStarted(
  userId: string,
  agent: { id: string; goal: string }
): Promise<void> {
  const startTime = Date.now();

  console.log('[SMS Outbound] notifyAgentStarted', {
    userId,
    agentId: agent.id,
    goalPreview: agent.goal.substring(0, 80),
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    console.log('[SMS Outbound] No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const goalPreview = agent.goal.length > 80 ? agent.goal.substring(0, 77) + '...' : agent.goal;
  const url = getAgentUrl(agent.id);
  const message = SMS_TEMPLATES.agentStarted(prefix, goalPreview, url);

  const result = await sendSms(phone, message);

  console.log('[SMS Outbound] agentStarted SMS sent', {
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

  console.log('[SMS Outbound] notifyPlannerMessage', {
    userId,
    agentId: agent.id,
    isQuestion,
    messageLength: messageText.length,
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    console.log('[SMS Outbound] No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const preview = messageText.length > 200 ? messageText.substring(0, 197) + '...' : messageText;
  const message = isQuestion
    ? SMS_TEMPLATES.plannerQuestion(prefix, preview)
    : SMS_TEMPLATES.plannerFyi(prefix, preview);

  const result = await sendSms(phone, message);

  console.log('[SMS Outbound] plannerMessage SMS sent', {
    userId,
    agentPrefix: prefix,
    isQuestion,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
}

/**
 * Notify user of a write lock approval request with shortcode.
 */
export async function notifyWriteLock(
  userId: string,
  agent: { id: string },
  question: string,
  attentionRequestId: string,
  workflowId: string
): Promise<void> {
  const startTime = Date.now();

  console.log('[SMS Outbound] notifyWriteLock', {
    userId,
    agentId: agent.id,
    attentionRequestId,
    questionPreview: question.substring(0, 100),
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    console.log('[SMS Outbound] No phone for user, skipping', { userId });
    return;
  }

  // Generate shortcode for this approval
  const shortcode = await createShortcode({
    userId,
    attentionRequestId,
    agentId: agent.id,
    workflowId,
  });

  const prefix = agent.id.substring(0, 6);
  const questionPreview = question.length > 150 ? question.substring(0, 147) + '...' : question;
  const message = SMS_TEMPLATES.writeLock(prefix, questionPreview, shortcode);

  const result = await sendSms(phone, message);

  console.log('[SMS Outbound] writeLock SMS sent', {
    userId,
    agentPrefix: prefix,
    shortcode,
    attentionRequestId,
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

  console.log('[SMS Outbound] notifyCompletion', {
    userId,
    agentId: agent.id,
    summaryLength: summary.length,
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    console.log('[SMS Outbound] No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const url = getAgentUrl(agent.id);
  const summaryPreview = summary.length > 200 ? summary.substring(0, 197) + '...' : summary;
  const message = SMS_TEMPLATES.agentCompleted(prefix, summaryPreview, url);

  const result = await sendSms(phone, message);

  console.log('[SMS Outbound] completion SMS sent', {
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
  agent: { id: string; treeCostCents: number; priceLimitCents: number }
): Promise<void> {
  const startTime = Date.now();

  console.log('[SMS Outbound] notifyCostLimit', {
    userId,
    agentId: agent.id,
    treeCostCents: agent.treeCostCents,
    priceLimitCents: agent.priceLimitCents,
  });

  const phone = await getUserPhone(userId);
  if (!phone) {
    console.log('[SMS Outbound] No phone for user, skipping', { userId });
    return;
  }

  const prefix = agent.id.substring(0, 6);
  const message = SMS_TEMPLATES.costLimit(prefix, agent.treeCostCents, agent.priceLimitCents);

  const result = await sendSms(phone, message);

  console.log('[SMS Outbound] costLimit SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
}
