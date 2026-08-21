/**
 * AgentCard persistence — the only module in this domain allowed to touch Prisma.
 *
 * Per-user tokens are stored in the existing `Integration` row (name="agentcard"),
 * mirroring how the email/Plaid OAuth integrations are persisted (avoids a schema
 * migration). Keyed by the stable Supabase userId.
 */

import { type Prisma, IntegrationStatus, IntegrationType } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../database';
import { AGENTCARD_INTEGRATION_NAME } from './config';
import type { StoredTokenConfig } from './types';

export async function saveTokenConfig(
  userId: string,
  tokenConfig: StoredTokenConfig
): Promise<void> {
  const config = tokenConfig as Prisma.InputJsonObject;
  await prisma.integration.upsert({
    where: { userId_name_accountId: { userId, name: AGENTCARD_INTEGRATION_NAME, accountId: '' } },
    create: {
      userId,
      name: AGENTCARD_INTEGRATION_NAME,
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config,
    },
    update: {
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config,
      lastUsedAt: new Date(),
    },
  });
}

export async function findTokenConfig(userId: string): Promise<unknown | undefined> {
  const row = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: AGENTCARD_INTEGRATION_NAME, accountId: '' } },
    select: { config: true },
  });
  return row === null ? undefined : row.config;
}

export async function findConnectedConfig(userId: string): Promise<unknown | undefined> {
  const row = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: AGENTCARD_INTEGRATION_NAME, accountId: '' } },
    select: { config: true, status: true, isActive: true },
  });
  return row?.status === IntegrationStatus.CONNECTED && row.isActive ? row.config : undefined;
}

/**
 * Every user id already bound to this AgentCard cardholder.
 *
 * A cardholder owns a funding wallet, so two users sharing one cardholder share one wallet and
 * commingle funds. Used to enforce the 1 user : 1 cardholder : 1 wallet invariant on write.
 */
export async function findUserIdsByCardholderId(cardholderId: string): Promise<string[]> {
  const rows = await prisma.integration.findMany({
    where: {
      name: AGENTCARD_INTEGRATION_NAME,
      config: { path: ['cardholderId'], equals: cardholderId },
    },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

/**
 * Bind a cardholder to a user, serialized against every other writer for that same cardholder.
 *
 * The ownership check and the write MUST be one atomic unit. Read-then-write lets two concurrent
 * calls for different users both observe "unowned" and both bind, which is precisely the
 * commingled-wallet outcome the invariant exists to prevent — and the read is a JSON path query,
 * so no unique index can catch it afterwards.
 *
 * `pg_advisory_xact_lock` is keyed by the cardholder id and released automatically when the
 * transaction ends (commit OR rollback), so a crash mid-write cannot strand the lock. Every writer
 * of this binding must go through here; `hashtext` collisions are harmless (they only serialize
 * two unrelated cardholders for the duration of one short transaction).
 */
export async function bindCardholderExclusively(
  userId: string,
  cardholderId: string,
  buildConfig: (existing: unknown | undefined) => Prisma.InputJsonObject
): Promise<{ conflictingUserId?: string }> {
  return runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agentcard:cardholder:${cardholderId}`}))`;

    const owners = await tx.integration.findMany({
      where: {
        name: AGENTCARD_INTEGRATION_NAME,
        config: { path: ['cardholderId'], equals: cardholderId },
      },
      select: { userId: true },
    });
    const conflicting = owners.map((row) => row.userId).find((owner) => owner !== userId);
    if (conflicting !== undefined) return { conflictingUserId: conflicting };

    const existing = await tx.integration.findUnique({
      where: { userId_name_accountId: { userId, name: AGENTCARD_INTEGRATION_NAME, accountId: '' } },
      select: { config: true },
    });
    const config = buildConfig(existing?.config);
    await tx.integration.upsert({
      where: { userId_name_accountId: { userId, name: AGENTCARD_INTEGRATION_NAME, accountId: '' } },
      create: {
        userId,
        name: AGENTCARD_INTEGRATION_NAME,
        type: IntegrationType.TOOL_SETUP,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        config,
      },
      update: {
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        config,
        lastUsedAt: new Date(),
      },
    });
    return {};
  });
}

export async function saveIntegrationConfig(
  userId: string,
  config: Prisma.InputJsonObject,
  connected: boolean
): Promise<void> {
  await prisma.integration.upsert({
    where: { userId_name_accountId: { userId, name: AGENTCARD_INTEGRATION_NAME, accountId: '' } },
    create: {
      userId,
      name: AGENTCARD_INTEGRATION_NAME,
      type: IntegrationType.TOOL_SETUP,
      status: connected ? IntegrationStatus.CONNECTED : IntegrationStatus.NOT_CONNECTED,
      isActive: true,
      config,
    },
    update: {
      status: connected ? IntegrationStatus.CONNECTED : IntegrationStatus.NOT_CONNECTED,
      isActive: true,
      config,
      lastUsedAt: new Date(),
    },
  });
}

export async function clearToken(userId: string): Promise<void> {
  await prisma.integration
    .update({
      where: { userId_name_accountId: { userId, name: AGENTCARD_INTEGRATION_NAME, accountId: '' } },
      data: { status: IntegrationStatus.NOT_CONNECTED, isActive: false, config: {} },
    })
    .catch(() => {
      // No row to clear — nothing to do.
    });
}
