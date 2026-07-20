import { logTruncate } from '../../utils/log';
import { sendSms, getUserPhone } from '../../providers/smsQueue';
import { createLogger } from '../../providers/logger';
import { SURGE_API_KEY, SURGE_ACCOUNT_ID } from './config';
import {
  notifyAgentStarted,
  notifyPlannerMessage,
  notifyWriteLock,
  notifyAgentCardSetup,
  notifyCompletion,
  notifyCostLimit,
} from '../../providers/smsSupervisor/outboundEvents';
import * as repo from './repo';
import type { NotifyInput } from './types';

const log = createLogger('SendSMS');

// ── Surge direct send ────────────────────────────────────────────────

export interface SurgeSendResult {
  success: boolean;
  message_id: string;
  phone_number: string;
  provider: 'surge';
}

export class SurgeNotConfiguredError extends Error {
  constructor() {
    super('Surge not configured');
    this.name = 'SurgeNotConfiguredError';
  }
}

export class SurgeApiError extends Error {
  status: number;
  details: string;
  constructor(status: number, details: string) {
    super(`Surge API error (${String(status)})`);
    this.name = 'SurgeApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Send an SMS via the Surge API.
 */
export async function sendViaSurge(phoneNumber: string, message: string): Promise<SurgeSendResult> {
  const apiKey = SURGE_API_KEY;
  const accountId = SURGE_ACCOUNT_ID;

  if (apiKey === undefined || apiKey === '' || accountId === undefined || accountId === '') {
    log.error('Surge credentials not configured');
    throw new SurgeNotConfiguredError();
  }

  const response = await fetch(`https://api.surge.app/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: phoneNumber,
      body: message,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('Surge API error', { status: response.status, body: logTruncate(errorText) });
    throw new SurgeApiError(response.status, errorText);
  }

  const result = (await response.json()) as { id: string; [key: string]: unknown };

  log.info('SMS sent via Surge', {
    messageId: result.id,
    phone: phoneNumber.substring(0, 4) + '****',
  });

  return {
    success: true,
    message_id: result.id,
    phone_number: phoneNumber,
    provider: 'surge',
  };
}

// ── Direct send (via smsQueue provider) ──────────────────────────────

export class UserHasNoPhoneError extends Error {
  constructor() {
    super('User has no phone number');
    this.name = 'UserHasNoPhoneError';
  }
}

/**
 * Send an SMS directly to a user (for welcome, completion - no queue).
 */
export async function sendDirect(userId: string, message: string) {
  const userPhone = await getUserPhone(userId);
  if (userPhone === null || userPhone === undefined || userPhone === '') {
    throw new UserHasNoPhoneError();
  }

  const result = await sendSms(userPhone, message, {
    archiveRootAgentId: userId,
    archiveContext: { source: 'send-sms-direct', user_id: userId },
  });

  log.info('Direct send result', {
    userId,
    success: result.success,
  });

  return result;
}

// ── Lifecycle notification ───────────────────────────────────────────

export interface NotifyResult {
  success: true;
  skipped?: boolean;
  reason?: string;
}

/**
 * Dispatch a lifecycle SMS notification for an agent event.
 * Skips if the agent has been deleted (race condition guard).
 */
export async function dispatchNotification(data: NotifyInput): Promise<NotifyResult> {
  const startTime = Date.now();

  log.info('SMS Notify received', {
    userId: data.user_id,
    eventType: data.event_type,
    agentId: data.agent_id,
    payload: JSON.stringify(data.payload ?? {}).substring(0, 200),
  });

  const agent = await repo.findAgentDeletedStatus(data.agent_id);
  if (!agent) {
    log.info('Agent not found, skipping SMS', {
      agentId: data.agent_id,
      eventType: data.event_type,
    });
    return { success: true, skipped: true, reason: 'agent_not_found' };
  }
  if (agent.deletedAt !== null && agent.deletedAt !== undefined) {
    log.info('Agent deleted, skipping SMS', {
      agentId: data.agent_id,
      eventType: data.event_type,
    });
    return { success: true, skipped: true, reason: 'agent_deleted' };
  }
  // Benchmark/eval runs create real root agents under the operator's own phone.
  // Lifecycle SMS (agent_started, write_lock, completion, …) fire on any source
  // now, so without this central gate every benchmark run would text the
  // operator. Suppress here so the workflow-side source guards can safely relax.
  if (agent.isBenchmark) {
    log.info('Agent is a benchmark run, skipping SMS', {
      agentId: data.agent_id,
      eventType: data.event_type,
    });
    return { success: true, skipped: true, reason: 'benchmark_agent' };
  }

  const payload = data.payload ?? {};

  await dispatchByEventType(data, payload, agent.goal);

  log.info('SMS Notify processed', {
    eventType: data.event_type,
    agentId: data.agent_id,
    durationMs: Date.now() - startTime,
  });

  return { success: true };
}

/* c8 ignore start -- dispatchByEventType delegates to smsSupervisor outboundEvents (excluded from coverage) */
/** Route to the correct outbound event handler based on event_type. */
async function dispatchByEventType(
  data: NotifyInput,
  payload: Record<string, unknown>,
  agentGoal: string
): Promise<void> {
  switch (data.event_type) {
    case 'agent_started':
      await notifyAgentStarted(data.user_id, {
        id: data.agent_id,
        goal: (payload.goal as string | undefined) ?? 'Unknown goal',
      });
      break;

    case 'planner_message':
      await notifyPlannerMessage(
        data.user_id,
        { id: data.agent_id },
        (payload.message as string | undefined) ?? '',
        (payload.is_question as boolean | undefined) ?? false
      );
      break;

    case 'write_lock':
      await notifyWriteLock(
        data.user_id,
        { id: data.agent_id },
        (payload.question as string | undefined) ?? '',
        (payload.attention_request_id as string | undefined) ?? '',
        (payload.workflow_id as string | undefined) ?? '',
        payload.metadata
      );
      break;

    case 'agentcard_setup': {
      // Validate the runtime type: the cast above does not guarantee a string, and a
      // missing/blank/non-string value would produce an unusable SMS or crash the
      // notifier's `.trim()`. Skip malformed events instead of dispatching.
      const setupUrl = payload.setup_url;
      if (typeof setupUrl !== 'string' || setupUrl.trim() === '') {
        log.warn('agentcard_setup event missing a valid setup_url, skipping', {
          agentId: data.agent_id,
        });
        break;
      }
      await notifyAgentCardSetup(data.user_id, { id: data.agent_id }, setupUrl);
      break;
    }

    case 'completion':
      await notifyCompletion(
        data.user_id,
        { id: data.agent_id },
        (payload.summary as string | undefined) ?? ''
      );
      break;

    case 'cost_limit':
      await notifyCostLimit(data.user_id, {
        id: data.agent_id,
        goal: agentGoal,
        treeCostCents: (payload.tree_cost_cents as number | undefined) ?? 0,
        priceLimitCents: (payload.price_limit_cents as number | undefined) ?? 0,
      });
      break;

    default:
      log.warn('Unknown event type, skipping', { eventType: data.event_type });
  }
}
/* c8 ignore stop */
