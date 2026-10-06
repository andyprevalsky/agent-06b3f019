import type { PhoneCallSession, Prisma } from '@prisma/client';

import { prisma } from '../../providers/database';
import type {
  PhoneCallSegment,
  PhoneCallSessionRecord,
  PhoneCallSessionState,
  PhoneHoldPeriod,
} from './types';

function toRecord(row: PhoneCallSession): PhoneCallSessionRecord {
  return {
    ...row,
    state: row.state as PhoneCallSessionState,
    assistantConfig: row.assistantConfig as Record<string, unknown>,
    segments: (Array.isArray(row.segments) ? row.segments : []) as unknown as PhoneCallSegment[],
    holds: (Array.isArray(row.holds) ? row.holds : []) as unknown as PhoneHoldPeriod[],
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export interface PhoneCallSessionPatch {
  rootVapiCallId?: string;
  activeVapiCallId?: string;
  twilioCallSid?: string;
  state?: PhoneCallSessionState;
  segments?: PhoneCallSegment[];
  holds?: PhoneHoldPeriod[];
  endedReason?: string;
  endedAt?: Date;
}

function toUpdateData(
  patch: PhoneCallSessionPatch
): Prisma.PhoneCallSessionUpdateManyMutationInput {
  return {
    ...(patch.rootVapiCallId !== undefined ? { rootVapiCallId: patch.rootVapiCallId } : {}),
    ...(patch.activeVapiCallId !== undefined ? { activeVapiCallId: patch.activeVapiCallId } : {}),
    ...(patch.twilioCallSid !== undefined ? { twilioCallSid: patch.twilioCallSid } : {}),
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.segments !== undefined ? { segments: json(patch.segments) } : {}),
    ...(patch.holds !== undefined ? { holds: json(patch.holds) } : {}),
    ...(patch.endedReason !== undefined ? { endedReason: patch.endedReason } : {}),
    ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
  };
}

export async function createPhoneCallSession(input: {
  id?: string;
  operationKey?: string;
  agentId?: string | null;
  userId?: string | null;
  phoneNumberId: string;
  fromNumber: string;
  toNumber: string;
  assistantConfig: Record<string, unknown>;
}): Promise<PhoneCallSessionRecord> {
  const row = await prisma.phoneCallSession.create({
    data: {
      ...(input.id !== undefined ? { id: input.id } : {}),
      operationKey: input.operationKey ?? null,
      agentId: input.agentId ?? null,
      userId: input.userId ?? null,
      phoneNumberId: input.phoneNumberId,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      assistantConfig: json(input.assistantConfig),
    },
  });
  return toRecord(row);
}

export async function findPhoneCallSession(id: string): Promise<PhoneCallSessionRecord | null> {
  const row = await prisma.phoneCallSession.findUnique({ where: { id } });
  return row === null ? null : toRecord(row);
}

export async function findPhoneCallSessionByRootVapiCallId(
  rootVapiCallId: string
): Promise<PhoneCallSessionRecord | null> {
  const row = await prisma.phoneCallSession.findUnique({ where: { rootVapiCallId } });
  return row === null ? null : toRecord(row);
}

export async function updatePhoneCallSession(
  id: string,
  patch: PhoneCallSessionPatch
): Promise<PhoneCallSessionRecord> {
  const row = await prisma.phoneCallSession.update({ where: { id }, data: toUpdateData(patch) });
  return toRecord(row);
}

export async function recordHoldDetectorUsage(input: {
  agentId: string;
  userId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costCents: number;
}): Promise<void> {
  await prisma.toolUsage.create({
    data: {
      userId: input.userId,
      agentId: input.agentId,
      toolName: 'vapi_hold_human_detector',
      totalCostCents: Math.round(input.costCents * 100) / 100,
      usageItems: [
        {
          type: 'llm',
          call_site: 'vapi_hold_human_detector',
          cost_cents: input.costCents,
          provider: input.model,
          model: input.model,
          tokens_in: input.promptTokens,
          tokens_out: input.completionTokens,
          number_of_tokens: input.promptTokens + input.completionTokens,
        },
      ],
    },
  });
}

/**
 * Compare-and-set on `state`: applies the patch only while the session is in
 * one of `from`. Returns the updated record, or null when another request
 * (a webhook retry, a racing listener) already moved it on.
 */
export async function transitionPhoneCallSession(
  id: string,
  from: PhoneCallSessionState[],
  patch: PhoneCallSessionPatch
): Promise<PhoneCallSessionRecord | null> {
  const result = await prisma.phoneCallSession.updateMany({
    where: { id, state: { in: from } },
    data: toUpdateData(patch),
  });
  if (result.count === 0) return null;
  return findPhoneCallSession(id);
}
