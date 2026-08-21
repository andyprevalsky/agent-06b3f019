/**
 * AgentCard persistence — the only module in this domain allowed to touch Prisma.
 *
 * Per-user tokens are stored in the existing `Integration` row (name="agentcard"),
 * mirroring how the email/Plaid OAuth integrations are persisted (avoids a schema
 * migration). Keyed by the stable Supabase userId.
 */

import { type Prisma, IntegrationStatus, IntegrationType } from '@prisma/client';
import { prisma } from '../database';
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
