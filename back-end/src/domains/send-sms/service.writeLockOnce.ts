/**
 * Cap write_lock SMS at the initial notification plus one extra reminder
 * per attention request. Temporal retries of the same kind reuse the claim.
 */
import { createLogger } from '../../providers/logger';
import {
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  reclaimFailedToolSideEffect,
} from '../../providers/toolSideEffects';
import { notifyWriteLock } from '../../providers/smsSupervisor/outboundEvents';
import type { SupervisorChannel } from '../../providers/smsSupervisor/channelDelivery';
import type { NotifyInput } from './types';

const log = createLogger('SendSMS');
const WRITE_LOCK_SMS_OPERATION_TYPE = 'lifecycle-sms.write_lock';

export async function dispatchWriteLockOnce(
  data: NotifyInput,
  payload: Record<string, unknown>,
  channels: SupervisorChannel[]
): Promise<void> {
  const attentionRequestId = (payload.attention_request_id as string | undefined) ?? '';
  const isReminder = payload.reminder === true;
  const kind = isReminder ? 'reminder' : 'initial';
  const operationKey =
    attentionRequestId === ''
      ? ''
      : `${WRITE_LOCK_SMS_OPERATION_TYPE}:${attentionRequestId}:${kind}`;

  if (operationKey !== '') {
    let claim = await claimToolSideEffect({
      operationKey,
      operationType: WRITE_LOCK_SMS_OPERATION_TYPE,
      request: {
        user_id: data.user_id,
        agent_id: data.agent_id,
        attention_request_id: attentionRequestId,
        kind,
      },
    });
    if (claim.status === 'existing' && claim.record.status === 'FAILED') {
      claim = await reclaimFailedToolSideEffect(operationKey);
    }
    if (claim.status === 'existing') {
      log.info('Write-lock SMS already claimed, skipping duplicate', {
        agentId: data.agent_id,
        attentionRequestId,
        kind,
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
        channels,
        isReminder
      );
      await markToolSideEffectSucceeded({
        operationKey,
        externalId: `${attentionRequestId}:${kind}`,
      });
    } catch (error) {
      await markToolSideEffectFailed({
        operationKey,
        error: error instanceof Error ? error.message : String(error),
      });
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
    channels,
    isReminder
  );
}
