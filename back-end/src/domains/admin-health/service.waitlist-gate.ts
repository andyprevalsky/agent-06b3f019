import { markOffWaitlistByPhone, type OffWaitlistResult } from '../../providers/inviteGate';
import {
  claimToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  reclaimFailedToolSideEffect,
  type ToolSideEffectJson,
  type ToolSideEffectRecord,
} from '../../providers/toolSideEffects';
import { WaitlistInviteInProgressError } from './service.waitlist-finalization';

const WAITLIST_INVITE_OPERATION_TYPE = 'admin-health.waitlist-invite';

export function waitlistInviteGateOperationKey(id: string, idempotencyKey: string) {
  return `waitlist-invite:${id}:${idempotencyKey}:gate`;
}

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

/**
 * Run the gate mutation and record its outcome, marking the side-effect record
 * FAILED (reclaimable) if either step throws. Without this, a mutation that
 * commits but whose success-record write fails would leave the record stuck
 * STARTED — every retry then returns 409 forever and the original outcome is
 * lost. Marking FAILED lets a later attempt reclaim and re-run: markOffWaitlist
 * ByPhone is idempotent and re-derives the correct current-state result.
 */
async function persistGateOutcome(params: {
  operationKey: string;
  phone: string;
}): Promise<OffWaitlistResult> {
  let result: OffWaitlistResult;
  try {
    result = await markOffWaitlistByPhone(params.phone);
  } catch (error) {
    await markToolSideEffectFailed({
      operationKey: params.operationKey,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  try {
    await markToolSideEffectSucceeded({
      operationKey: params.operationKey,
      externalId: result.userId ?? 'no-account',
      response: result as unknown as ToolSideEffectJson,
    });
  } catch (error) {
    await markToolSideEffectFailed({
      operationKey: params.operationKey,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return result;
}

/** Resolve an existing side-effect record: return, reclaim+retry, or reject. */
async function resumeGateOutcome(params: {
  operationKey: string;
  phone: string;
  record: ToolSideEffectRecord;
}): Promise<OffWaitlistResult> {
  if (params.record.status === 'SUCCEEDED') {
    return parseStoredGateResult(params.record.response);
  }
  if (params.record.status !== 'FAILED') {
    // STARTED — a concurrent attempt currently holds the claim.
    throw new WaitlistInviteInProgressError();
  }
  const claim = await reclaimFailedToolSideEffect(params.operationKey);
  if (claim.status !== 'claimed') {
    if (claim.record.status === 'SUCCEEDED') {
      return parseStoredGateResult(claim.record.response);
    }
    throw new WaitlistInviteInProgressError();
  }
  return persistGateOutcome({ operationKey: params.operationKey, phone: params.phone });
}

/** Claim and persist the gate mutation before any external invite delivery. */
export async function resolveInviteGate(params: {
  id: string;
  idempotencyKey: string;
  phone: string;
}): Promise<OffWaitlistResult> {
  const operationKey = waitlistInviteGateOperationKey(params.id, params.idempotencyKey);
  let claim = await claimToolSideEffect({
    operationKey,
    operationType: WAITLIST_INVITE_OPERATION_TYPE,
    request: { waitlistId: params.id, phone: params.phone },
  });
  if (claim.status === 'existing' && claim.record.status === 'FAILED') {
    claim = await reclaimFailedToolSideEffect(operationKey);
  }
  if (claim.status === 'claimed') {
    return persistGateOutcome({ operationKey, phone: params.phone });
  }
  return resumeGateOutcome({ operationKey, phone: params.phone, record: claim.record });
}
