import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { randomUUID } from './crypto';

const ACTIVE_PREFIX = 'agentphone:provisioning:';
const RECOVERY_PREFIX = 'agentphone:recovery:';
export const AGENT_PHONE_PROVISIONING_LEASE_MS = 180_000;
const POLL_MS = 250;

export type PersistedAgentPhoneNumber = {
  agentId: string;
  numberId: string;
  phoneNumber: string;
};

export type AgentPhoneProvisioningClaim =
  | { kind: 'complete'; number: PersistedAgentPhoneNumber }
  | { kind: 'owner'; marker: string; recoveryRequired: boolean }
  | { kind: 'wait'; marker: string };

type ParsedMarker = { kind: 'active' | 'recovery'; startedAt: number };

function parseMarker(value: string | null): ParsedMarker | null {
  if (value === null) return null;
  const kind = value.startsWith(ACTIVE_PREFIX)
    ? 'active'
    : value.startsWith(RECOVERY_PREFIX)
      ? 'recovery'
      : null;
  if (kind === null) return null;
  const prefix = kind === 'active' ? ACTIVE_PREFIX : RECOVERY_PREFIX;
  const startedAt = Number(value.slice(prefix.length).split(':', 1)[0]);
  return Number.isFinite(startedAt) ? { kind, startedAt } : null;
}

function newMarker(prefix = ACTIVE_PREFIX): string {
  return `${prefix}${Date.now()}:${randomUUID()}`;
}

function persistedNumber(identity: {
  phone: string | null;
  phoneProviderAgentId: string | null;
  phoneProviderNumberId: string | null;
}): PersistedAgentPhoneNumber | null {
  if (
    identity.phone === null ||
    identity.phoneProviderAgentId === null ||
    identity.phoneProviderNumberId === null
  ) {
    return null;
  }
  return {
    agentId: identity.phoneProviderAgentId,
    numberId: identity.phoneProviderNumberId,
    phoneNumber: identity.phone,
  };
}

async function lockUser(transaction: Prisma.TransactionClient, userId: string): Promise<void> {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`agentphone-provision:${userId}`}))
  `;
}

export async function claimAgentPhoneProvisioning(
  userId: string
): Promise<AgentPhoneProvisioningClaim> {
  return runTransactionWithRetry(async (transaction) => {
    await lockUser(transaction, userId);
    const identity = await transaction.agentIdentity.findUniqueOrThrow({ where: { userId } });
    const number = persistedNumber(identity);
    if (number !== null) return { kind: 'complete', number };

    const parsed = parseMarker(identity.phoneProvider);
    if (
      parsed?.kind === 'active' &&
      Date.now() - parsed.startedAt < AGENT_PHONE_PROVISIONING_LEASE_MS
    ) {
      return { kind: 'wait', marker: identity.phoneProvider as string };
    }

    const marker = newMarker();
    await transaction.agentIdentity.update({
      where: { userId },
      data: { phoneProvider: marker },
    });
    return {
      kind: 'owner',
      marker,
      recoveryRequired: parsed !== null || identity.phoneProviderAgentId !== null,
    };
  });
}

export async function waitForAgentPhoneProvisioning(
  userId: string,
  marker: string,
  requestDeadlineAt: number
): Promise<PersistedAgentPhoneNumber | null> {
  const identity = await prisma.agentIdentity.findUniqueOrThrow({ where: { userId } });
  const number = persistedNumber(identity);
  if (number !== null) return number;
  if (identity.phoneProvider !== marker) return null;
  const parsed = parseMarker(marker);
  if (parsed === null) return null;
  const now = Date.now();
  const markerDeadlineAt = parsed.startedAt + AGENT_PHONE_PROVISIONING_LEASE_MS;
  const nextDeadlineAt = Math.min(markerDeadlineAt, requestDeadlineAt);
  if (now >= nextDeadlineAt) return null;
  await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, nextDeadlineAt - now)));
  return waitForAgentPhoneProvisioning(userId, marker, requestDeadlineAt);
}

export async function completeAgentPhoneProvisioning(
  userId: string,
  marker: string,
  number: PersistedAgentPhoneNumber
): Promise<void> {
  await runTransactionWithRetry(async (transaction) => {
    await lockUser(transaction, userId);
    const result = await transaction.agentIdentity.updateMany({
      where: { userId, phoneProvider: marker },
      data: {
        phone: number.phoneNumber,
        phoneProvider: 'agentphone',
        phoneProviderAgentId: number.agentId,
        phoneProviderNumberId: number.numberId,
      },
    });
    if (result.count !== 1) throw new Error('AgentPhone provisioning lease ownership was lost');
  });
}

export async function releaseAgentPhoneProvisioning(
  userId: string,
  marker: string,
  recoveryRequired: boolean
): Promise<void> {
  await runTransactionWithRetry(async (transaction) => {
    await lockUser(transaction, userId);
    await transaction.agentIdentity.updateMany({
      where: { userId, phoneProvider: marker },
      data: { phoneProvider: recoveryRequired ? newMarker(RECOVERY_PREFIX) : null },
    });
  });
}
