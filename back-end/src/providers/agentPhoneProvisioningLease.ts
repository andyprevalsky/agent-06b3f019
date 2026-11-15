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
  | {
      kind: 'owner';
      marker: string;
      recoveryRequired: boolean;
      existingAgentId: string | null;
      existingNumberId: string | null;
      /** Lower bound on when an agent create from this lease chain may have landed. */
      uncertainSince: number;
    }
  | { kind: 'wait'; marker: string };

type ParsedMarker = {
  kind: 'active' | 'recovery';
  startedAt: number;
  uncertainSince: number | null;
};
const SINCE_FIELD = ':since:';

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
  if (!Number.isFinite(startedAt)) return null;
  const sinceIndex = value.lastIndexOf(SINCE_FIELD);
  const since = sinceIndex < 0 ? Number.NaN : Number(value.slice(sinceIndex + SINCE_FIELD.length));
  return { kind, startedAt, uncertainSince: Number.isFinite(since) ? since : null };
}

// `<prefix><lease start>:<uuid>:since:<uncertainSince>`. Every marker in a lease
// chain carries the chain's lower bound, so a crashed or failed recovery keeps it.
function newMarker(prefix: string, startedAt: number, uncertainSince: number): string {
  return `${prefix}${startedAt}:${randomUUID()}${SINCE_FIELD}${uncertainSince}`;
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

    const startedAt = Date.now();
    const recoveryRequired = parsed !== null || identity.phoneProviderAgentId !== null;
    // A legacy or unknown chain is bounded by the identity row: no agent carrying
    // this user's provisioning marker can predate the lease row it was created for.
    const uncertainSince = !recoveryRequired
      ? startedAt
      : (parsed?.uncertainSince ?? identity.createdAt.getTime());
    const marker = newMarker(ACTIVE_PREFIX, startedAt, uncertainSince);
    await transaction.agentIdentity.update({
      where: { userId },
      data: { phoneProvider: marker },
    });
    return {
      kind: 'owner',
      marker,
      recoveryRequired,
      existingAgentId: identity.phoneProviderAgentId,
      existingNumberId: identity.phoneProviderNumberId,
      uncertainSince,
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

export async function progressAgentPhoneProvisioning(
  userId: string,
  marker: string,
  agentId: string
): Promise<void> {
  await runTransactionWithRetry(async (transaction) => {
    await lockUser(transaction, userId);
    await transaction.agentIdentity.updateMany({
      where: { userId, phoneProvider: marker },
      data: { phoneProviderAgentId: agentId },
    });
  });
}

// A stored agent id makes the next claim a recovery, so an id whose provider
// agent this lease confirmed absent must not outlive the lease.
export async function forgetDeletedAgentPhoneAgent(
  userId: string,
  marker: string,
  agentId: string
): Promise<void> {
  await runTransactionWithRetry(async (transaction) => {
    await lockUser(transaction, userId);
    await transaction.agentIdentity.updateMany({
      where: { userId, phoneProvider: marker, phoneProviderAgentId: agentId },
      data: { phoneProviderAgentId: null },
    });
  });
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
  recoveryRequired: boolean,
  uncertainSince: number
): Promise<void> {
  await runTransactionWithRetry(async (transaction) => {
    await lockUser(transaction, userId);
    await transaction.agentIdentity.updateMany({
      where: { userId, phoneProvider: marker },
      data: {
        phoneProvider: recoveryRequired
          ? newMarker(RECOVERY_PREFIX, Date.now(), uncertainSince)
          : null,
      },
    });
  });
}
