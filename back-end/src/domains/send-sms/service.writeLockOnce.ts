/**
 * Cap write_lock SMS at the initial notification per attention request.
 * Reminder payloads are ignored. Temporal retries of the initial send reuse
 * the claim.
 */
import { createLogger } from '../../providers/logger';
import {
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  reclaimFailedToolSideEffect,
} from '../../providers/toolSideEffects';
import { notifyWriteLock } from '../../providers/smsSupervisor/outboundEvents';
import { NotificationDeliveryError } from '../../providers/smsSupervisor/notificationDelivery';
import type { SupervisorChannel } from '../../providers/smsSupervisor/channelDelivery';
import type { NotifyInput } from './types';

const log = createLogger('SendSMS');
const WRITE_LOCK_SMS_OPERATION_TYPE = 'lifecycle-sms.write_lock';

export async function dispatchWriteLockOnce(
  data: NotifyInput,
  payload: Record<string, unknown>,
  channels: SupervisorChannel[]
): Promise<void> {
  if (payload.reminder === true) {
    log.info('Write-lock reminder SMS is disabled, skipping', {
      agentId: data.agent_id,
      attentionRequestId: (payload.attention_request_id as string | undefined) ?? '',
    });
    return;
  }

  const attentionRequestId = (payload.attention_request_id as string | undefined) ?? '';
  const operationKey =
    attentionRequestId === ''
      ? ''
      : `${WRITE_LOCK_SMS_OPERATION_TYPE}:${attentionRequestId}:initial`;

  if (operationKey !== '') {
    let claim = await claimToolSideEffect({
      operationKey,
      operationType: WRITE_LOCK_SMS_OPERATION_TYPE,
      request: {
        user_id: data.user_id,
        agent_id: data.agent_id,
        attention_request_id: attentionRequestId,
        kind: 'initial',
      },
    });
    if (claim.status === 'existing' && claim.record.status === 'FAILED') {
      claim = await reclaimFailedToolSideEffect(operationKey);
    }
    if (claim.status === 'existing') {
      log.info('Write-lock SMS already claimed, skipping duplicate', {
        agentId: data.agent_id,
        attentionRequestId,
        kind: 'initial',
        status: claim.record.status,
      });
      return;
    }
    try {
      await notifyWriteLock(
        data.user_id,
        { id: data.agent_id },
        (payload.question as string | undefined) ?? '',
        attentionRequestId,
        (payload.workflow_id as string | undefined) ?? '',
        payload.metadata,
        channels
      );
      await markToolSideEffectSucceeded({
        operationKey,
        externalId: `${attentionRequestId}:initial`,
      });
    } catch (error) {
      // Only a known rejection can be retried safely. A timeout or an error
      // recording an accepted send keeps the original claim non-reclaimable.
      if (error instanceof NotificationDeliveryError && error.definitiveFailure) {
        await markToolSideEffectFailed({ operationKey, error: error.message });
      }
      throw error;
    }
    return;
  }

  await notifyWriteLock(
    data.user_id,
    { id: data.agent_id },
    (payload.question as string | undefined) ?? '',
    attentionRequestId,
    (payload.workflow_id as string | undefined) ?? '',
    payload.metadata,
    channels
  );
}
