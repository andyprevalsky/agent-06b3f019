/**
 * Integrations domain repo — email credential operations.
 * Split from repo.ts for max-lines compliance.
 */

import { type Prisma, EmailProvider, IntegrationStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function createEmailCredential(params: {
  userId: string;
  provider: EmailProvider;
  integrationId: string;
  pkceVerifier: string;
  stateToken: string;
  scopes: string[];
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.emailIntegrationCredential.create({
    data: {
      userId: params.userId,
      provider: params.provider,
      integrationId: params.integrationId,
      email: null,
      pkceVerifier: params.pkceVerifier,
      stateToken: params.stateToken,
      scopes: params.scopes,
      metadata: params.metadata,
    },
  });
}

export async function findCredentialByState(provider: EmailProvider, stateToken: string) {
  const STATE_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
  return prisma.emailIntegrationCredential.findFirst({
    where: {
      provider,
      stateToken,
      createdAt: { gte: new Date(Date.now() - STATE_TOKEN_TTL_MS) },
    },
  });
}

export async function findExistingCredential(params: {
  userId: string;
  provider: EmailProvider;
  email: string;
  excludeId: string;
}) {
  return prisma.emailIntegrationCredential.findFirst({
    where: {
      userId: params.userId,
      provider: params.provider,
      email: params.email,
      id: { not: params.excludeId },
    },
  });
}

export async function deleteEmailCredential(credentialId: string) {
  return prisma.emailIntegrationCredential.delete({
    where: { id: credentialId },
  });
}

export async function updateEmailCredential(
  credentialId: string,
  data: Prisma.EmailIntegrationCredentialUpdateInput
) {
  return prisma.emailIntegrationCredential.update({
    where: { id: credentialId },
    data,
  });
}

export async function findConnectedEmailCredentials(userId: string, provider: EmailProvider) {
  return prisma.emailIntegrationCredential.findMany({
    where: {
      userId,
      provider,
      email: { not: null },
      accessToken: { not: null },
    },
    select: { email: true },
  });
}

export async function findGmailIntegrationsWithCredentials(userId: string) {
  return prisma.integration.findMany({
    where: {
      userId,
      name: 'gmail',
      status: IntegrationStatus.CONNECTED,
    },
    include: {
      emailCredentials: {
        where: { provider: EmailProvider.GMAIL },
      },
    },
  });
}

export async function findGmailCredentialForSend(userId: string, fromEmail: string) {
  return prisma.emailIntegrationCredential.findFirst({
    where: {
      userId,
      provider: EmailProvider.GMAIL,
      accessToken: { not: null },
      email: fromEmail,
    },
    include: {
      integration: true,
    },
  });
}

export async function findGmailCredentialForDisconnect(userId: string, email: string) {
  return prisma.emailIntegrationCredential.findFirst({
    where: {
      userId,
      provider: EmailProvider.GMAIL,
      email,
    },
    include: {
      integration: true,
    },
  });
}

export async function findAvailableGmailEmails(userId: string) {
  return prisma.emailIntegrationCredential.findMany({
    where: { userId, provider: EmailProvider.GMAIL, accessToken: { not: null } },
    select: { email: true },
  });
}

export async function findMintedAccountEmails(userId: string) {
  const rows = await prisma.mintedAccount.findMany({
    where: {
      userId,
      disabledAt: null,
      accountLabel: { contains: '@' },
    },
    select: { accountLabel: true },
  });
  return [...new Set(rows.map((row) => row.accountLabel).filter((email) => email !== ''))];
}

export async function updateEmailCredentialToken(
  credentialId: string,
  data: {
    accessToken: string;
    expiresAt: Date | null;
    refreshToken?: string;
  }
) {
  return prisma.emailIntegrationCredential.update({
    where: { id: credentialId },
    data: {
      accessToken: data.accessToken,
      expiresAt: data.expiresAt,
      ...(data.refreshToken !== undefined &&
        data.refreshToken !== '' && { refreshToken: data.refreshToken }),
    },
  });
}
