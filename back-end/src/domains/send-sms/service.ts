import { logTruncate } from '../../utils/log';
import { sendSms, getUserPhone } from '../../providers/smsQueue';
import { createLogger } from '../../providers/logger';
import { SURGE_API_KEY, SURGE_ACCOUNT_ID } from './config';
import {
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  type ToolSideEffectJson,
} from '../../providers/toolSideEffects';
import {
  notifyAgentStarted,
  notifyPlannerMessage,
  notifyWriteLock,
  notifyAgentCardSetup,
  notifyCompletion,
  notifyCostLimit,
  buildCompletionSmsBody,
} from '../../providers/smsSupervisor/outboundEvents';
import * as repo from './repo';
import type { NotifyInput } from './types';
import {
  notificationChannelsFor,
  isWhatsAppConfigured,
  type SupervisorChannel,
} from '../../providers/smsSupervisor/channelDelivery';
import { getWhatsAppReachable } from '../../providers/whatsappReachability';

const log = createLogger('SendSMS');
const COMPLETION_SMS_OPERATION_TYPE = 'lifecycle-sms.completion';

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
  messagePreview?: string;
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
  const payload = data.payload ?? {};

  // Benchmark/eval runs create real root agents under the operator's own phone.
  // Lifecycle SMS (agent_started, write_lock, completion, …) fire on any source
  // now, so without this central gate every benchmark run would text the
  // operator. Completion still returns the production-formatted body so an eval
  // can assert the full notification contract without crossing the SMS boundary.
  if (agent.isBenchmark) {
    log.info('Agent is a benchmark run, skipping SMS', {
      agentId: data.agent_id,
      eventType: data.event_type,
    });
    const messagePreview =
      data.event_type === 'completion'
        ? buildCompletionSmsBody(
            data.agent_id,
            (payload.summary as string | undefined) ?? '',
            payload.outputs
          )
        : undefined;
    return { success: true, skipped: true, reason: 'benchmark_agent', messagePreview };
  }

  // Mirror lifecycle/onboarding notifications across every channel the user is
  // reachable on: SMS always, plus WhatsApp when configured and the number is
  // not known-unreachable. A WhatsApp-sourced agent's user just texted us on
  // WhatsApp, so include it even if the reachability flag hasn't caught up yet.
  const reachable = await getWhatsAppReachable(data.user_id);
  const channels = notificationChannelsFor(reachable);
  // A WhatsApp-sourced agent's user just texted us, so include WhatsApp even if
  // the reachability flag hasn't caught up (null) — but NEVER when the number is
  // known-unreachable (false), or we'd hammer a number that can't receive.
  if (
    agent.source === 'WHATSAPP' &&
    isWhatsAppConfigured() &&
    reachable !== false &&
    !channels.includes('WHATSAPP')
  ) {
    channels.push('WHATSAPP');
  }

  if (data.event_type === 'completion') {
    return dispatchCompletionOnce(data, payload, channels);
  }

  await dispatchByEventType(data, payload, agent.goal, channels);

  log.info('SMS Notify processed', {
    eventType: data.event_type,
    agentId: data.agent_id,
    durationMs: Date.now() - startTime,
  });

  return { success: true };
}

async function dispatchCompletionOnce(
  data: NotifyInput,
  payload: Record<string, unknown>,
  channels: SupervisorChannel[]
): Promise<NotifyResult> {
  const operationKey = `${COMPLETION_SMS_OPERATION_TYPE}:${data.agent_id}`;
  const claim = await claimToolSideEffect({
    operationKey,
    operationType: COMPLETION_SMS_OPERATION_TYPE,
    request: {
      user_id: data.user_id,
      agent_id: data.agent_id,
      event_type: data.event_type,
    },
  });
  if (claim.status === 'existing') {
    log.info('Completion SMS already claimed, skipping duplicate', {
      agentId: data.agent_id,
      status: claim.record.status,
    });
    return { success: true, skipped: true, reason: 'duplicate_completion' };
  }

  const delivery = await notifyCompletion(
    data.user_id,
    { id: data.agent_id },
    (payload.summary as string | undefined) ?? '',
    payload.outputs,
    channels
  );
  if (!delivery.success) {
    if (delivery.definitiveFailure === true) {
      await markToolSideEffectFailed({
        operationKey,
        error: delivery.error ?? 'Completion SMS provider rejected the message',
      });
    }
    throw new Error(delivery.error ?? 'Completion SMS delivery failed');
  }

  await markToolSideEffectSucceeded({
    operationKey,
    externalId: delivery.messageSid ?? `${data.agent_id}:no-phone`,
    response: delivery as ToolSideEffectJson,
  });
  return { success: true, skipped: delivery.skipped };
}

/* c8 ignore start -- dispatchByEventType delegates to smsSupervisor outboundEvents (excluded from coverage) */
/** Route to the correct outbound event handler based on event_type. */
async function dispatchByEventType(
  data: NotifyInput,
  payload: Record<string, unknown>,
  agentGoal: string,
  channels: SupervisorChannel[]
): Promise<void> {
  switch (data.event_type) {
    case 'agent_started':
      await notifyAgentStarted(
        data.user_id,
        {
          id: data.agent_id,
          // Prefer the payload's goal (the worker may have refined it), but fall
          // back to the goal already read off the Agent row rather than to the
          // literal string "Unknown goal" — a caller that omits `goal` otherwise
          // texts the user `Started: "Unknown goal"` about their own request.
          goal: (payload.goal as string | undefined) ?? agentGoal,
        },
        channels
      );
      break;

    case 'planner_message':
      await notifyPlannerMessage(
        data.user_id,
        { id: data.agent_id },
        (payload.message as string | undefined) ?? '',
        (payload.is_question as boolean | undefined) ?? false,
        channels
      );
      break;

    case 'write_lock':
      await notifyWriteLock(
        data.user_id,
        { id: data.agent_id },
        (payload.question as string | undefined) ?? '',
        (payload.attention_request_id as string | undefined) ?? '',
        (payload.workflow_id as string | undefined) ?? '',
        payload.metadata,
        channels
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
      await notifyAgentCardSetup(data.user_id, { id: data.agent_id }, setupUrl, channels);
      break;
    }

    case 'cost_limit':
      await notifyCostLimit(
        data.user_id,
        {
          id: data.agent_id,
          goal: agentGoal,
          treeCostCents: (payload.tree_cost_cents as number | undefined) ?? 0,
          priceLimitCents: (payload.price_limit_cents as number | undefined) ?? 0,
        },
        channels
      );
      break;

    default:
      log.warn('Unknown event type, skipping', { eventType: data.event_type });
  }
}
/* c8 ignore stop */
