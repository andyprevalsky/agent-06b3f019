/* c8 ignore start -- dispatchByEventType delegates to smsSupervisor outboundEvents (excluded from coverage) */
import { createLogger } from '../../providers/logger';
import {
  notifyAgentStarted,
  notifyPlannerMessage,
  notifyAgentCardSetup,
  notifyCostLimit,
} from '../../providers/smsSupervisor/outboundEvents';
import type { SupervisorChannel } from '../../providers/smsSupervisor/channelDelivery';
import type { NotifyInput } from './types';
import { dispatchWriteLockOnce } from './service.writeLockOnce';

const log = createLogger('SendSMS');

/** Route to the correct outbound event handler based on event_type. */
export async function dispatchByEventType(
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
      await dispatchWriteLockOnce(data, payload, channels);
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
