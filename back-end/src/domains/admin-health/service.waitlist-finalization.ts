import {
  claimToolSideEffect,
  findToolSideEffect,
  markToolSideEffectFailed,
  markToolSideEffectSucceeded,
  reclaimFailedToolSideEffect,
  type ToolSideEffectJson,
  type ToolSideEffectRecord,
} from '../../providers/toolSideEffects';
import type { AdminWaitlistInviteResponse } from './types';

const WAITLIST_INVITE_OPERATION_TYPE = 'admin-health.waitlist-invite';

export class WaitlistInviteInProgressError extends Error {
  constructor() {
    super('This invite attempt is already in progress');
    this.name = 'WaitlistInviteInProgressError';
  }
}

export function waitlistInviteFinalOperationKey(id: string, idempotencyKey: string) {
  return `waitlist-invite:${id}:${idempotencyKey}:final`;
}

type MarkInvited = (id: string, invitedAt: Date) => Promise<void>;

function parseStoredInviteResponse(
  value: unknown,
  expectedId: string
): AdminWaitlistInviteResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored waitlist invite outcome is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.id !== expectedId ||
    typeof candidate.invitedAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.invitedAt)) ||
    typeof candidate.smsSent !== 'boolean' ||
    typeof candidate.emailSent !== 'boolean' ||
    typeof candidate.flagged !== 'boolean' ||
    typeof candidate.alreadyOffWaitlist !== 'boolean' ||
    typeof candidate.hasAccount !== 'boolean'
  ) {
    throw new Error('Stored waitlist invite outcome is invalid');
  }
  return candidate as unknown as AdminWaitlistInviteResponse;
}

async function persistFinalOutcome(params: {
  operationKey: string;
  result: AdminWaitlistInviteResponse;
  markInvited: MarkInvited;
}): Promise<AdminWaitlistInviteResponse> {
  try {
    await params.markInvited(params.result.id, new Date(params.result.invitedAt));
  } catch (error) {
    // Reusing this timestamp makes retry safe even if the first update landed.
    await markToolSideEffectFailed({
      operationKey: params.operationKey,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await markToolSideEffectSucceeded({
    operationKey: params.operationKey,
    externalId: params.result.invitedAt,
    response: params.result as unknown as ToolSideEffectJson,
  });
  return params.result;
}

async function resumeFinalOutcome(params: {
  id: string;
  record: ToolSideEffectRecord;
  markInvited: MarkInvited;
}): Promise<AdminWaitlistInviteResponse> {
  if (params.record.status === 'SUCCEEDED') {
    return parseStoredInviteResponse(params.record.response, params.id);
  }
  if (params.record.status === 'STARTED') {
    let result: AdminWaitlistInviteResponse;
    try {
      result = parseStoredInviteResponse(params.record.request, params.id);
    } catch {
      throw new WaitlistInviteInProgressError();
    }
    // Finalization contains only an idempotent DB timestamp write. Replaying a
    // stored result is safe when the first success-record write was interrupted.
    return persistFinalOutcome({
      operationKey: params.record.operationKey,
      result,
      markInvited: params.markInvited,
    });
  }
  if (params.record.status !== 'FAILED') throw new WaitlistInviteInProgressError();

  const claim = await reclaimFailedToolSideEffect(params.record.operationKey);
  if (claim.status !== 'claimed') {
    if (claim.record.status === 'SUCCEEDED') {
      return parseStoredInviteResponse(claim.record.response, params.id);
    }
    throw new WaitlistInviteInProgressError();
  }
  return persistFinalOutcome({
    operationKey: params.record.operationKey,
    result: parseStoredInviteResponse(claim.record.request, params.id),
    markInvited: params.markInvited,
  });
}

export async function findStoredInviteFinalOutcome(params: {
  id: string;
  idempotencyKey: string;
  markInvited: MarkInvited;
}): Promise<AdminWaitlistInviteResponse | null> {
  const record = await findToolSideEffect(
    waitlistInviteFinalOperationKey(params.id, params.idempotencyKey)
  );
  if (record === null) return null;
  return resumeFinalOutcome({ id: params.id, record, markInvited: params.markInvited });
}

export async function finalizeWaitlistInviteOutcome(params: {
  result: AdminWaitlistInviteResponse;
  idempotencyKey: string;
  markInvited: MarkInvited;
}): Promise<AdminWaitlistInviteResponse> {
  const operationKey = waitlistInviteFinalOperationKey(params.result.id, params.idempotencyKey);
  let claim = await claimToolSideEffect({
    operationKey,
    operationType: WAITLIST_INVITE_OPERATION_TYPE,
    request: params.result as unknown as ToolSideEffectJson,
  });
  if (claim.status === 'existing' && claim.record.status === 'FAILED') {
    claim = await reclaimFailedToolSideEffect(operationKey);
  }
  if (claim.status === 'claimed') {
    return persistFinalOutcome({
      operationKey,
      result: parseStoredInviteResponse(claim.record.request, params.result.id),
      markInvited: params.markInvited,
    });
  }
  return resumeFinalOutcome({
    id: params.result.id,
    record: claim.record,
    markInvited: params.markInvited,
  });
}
