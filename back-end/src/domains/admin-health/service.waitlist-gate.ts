import { markOffWaitlistByPhone, type OffWaitlistResult } from '../../providers/inviteGate';
import {
  claimToolSideEffect,
  markToolSideEffectSucceeded,
  type ToolSideEffectJson,
} from '../../providers/toolSideEffects';
import { WaitlistInviteInProgressError } from './service.waitlist-finalization';

const WAITLIST_INVITE_OPERATION_TYPE = 'admin-health.waitlist-invite';

function parseStoredGateResult(value: unknown): OffWaitlistResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored waitlist gate outcome is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.flagged !== 'boolean' ||
    typeof candidate.alreadyOffWaitlist !== 'boolean' ||
    (candidate.userId !== null && typeof candidate.userId !== 'string')
  ) {
    throw new Error('Stored waitlist gate outcome is invalid');
  }
  return candidate as unknown as OffWaitlistResult;
}

/** Claim and persist the gate mutation before any external invite delivery. */
export async function resolveInviteGate(params: {
  id: string;
  idempotencyKey: string;
  phone: string;
}): Promise<OffWaitlistResult> {
  const operationKey = `waitlist-invite:${params.id}:${params.idempotencyKey}:gate`;
  const claim = await claimToolSideEffect({
    operationKey,
    operationType: WAITLIST_INVITE_OPERATION_TYPE,
    request: { waitlistId: params.id, phone: params.phone },
  });
  if (claim.status === 'existing') {
    if (claim.record.status === 'SUCCEEDED') {
      return parseStoredGateResult(claim.record.response);
    }
    throw new WaitlistInviteInProgressError();
  }

  const result = await markOffWaitlistByPhone(params.phone);
  await markToolSideEffectSucceeded({
    operationKey,
    externalId: result.userId ?? 'no-account',
    response: result as unknown as ToolSideEffectJson,
  });
  return result;
}
