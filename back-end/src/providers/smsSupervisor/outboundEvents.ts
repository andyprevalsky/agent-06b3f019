/**
 * SMS Outbound Lifecycle Events
 *
 * Template-based outbound SMS for agent lifecycle events. No LLM involved —
 * these are triggered directly by the agent workflow for speed.
 *
 * Only fires for SMS-source root agents.
 */

import { createLogger } from '../logger';
import { sendSms, getUserPhone } from '../smsQueue';
import { SMS_TEMPLATES, getAgentUrl } from '../smsTemplates';
import { createShortcode } from './shortcodes';

const log = createLogger('OutboundEvents');

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

  const result = await sendSms(phone, message);

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

  const result = await sendSms(phone, message);

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

  // Generate shortcode for this approval
  const shortcode = await createShortcode({
    userId,
    attentionRequestId,
    agentId: agent.id,
    workflowId,
  });

  const prefix = agent.id.substring(0, 6);
  const message = SMS_TEMPLATES.writeLock(prefix, question, shortcode);

  const result = await sendSms(phone, message);

  log.info('writeLock SMS sent', {
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

  const result = await sendSms(phone, message);

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

  const result = await sendSms(phone, message);

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
  agent: { id: string; treeCostCents: number; priceLimitCents: number }
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
  const message = SMS_TEMPLATES.costLimit(prefix, agent.treeCostCents, agent.priceLimitCents);

  const result = await sendSms(phone, message);

  log.info('costLimit SMS sent', {
    userId,
    agentPrefix: prefix,
    success: result.success,
    messageSid: result.messageSid,
    durationMs: Date.now() - startTime,
  });
}
