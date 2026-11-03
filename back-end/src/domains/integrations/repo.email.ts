/**
 * Integrations domain repo — email credential operations.
 * Split from repo.ts for max-lines compliance.
 */

import { type Prisma, EmailProvider, IntegrationStatus } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { GOOGLE_OAUTH_SCOPES } from './googleScopes';
import { encryptGoogleToken, readGoogleToken } from '../../providers/googleCredentials';
import { revokeQueuedGoogleGrants } from '../../services/integrations/googleDisconnect';

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
  const { deleted, revocations } = await runTransactionWithRetry(async (tx) => {
    // Gmail message inserts hold a share lock on this row. Take the exclusive
    // lock before creating the purge job so requestedAt follows every insert
    // that was already in flight.
    await tx.$queryRaw`SELECT "id" FROM "EmailIntegrationCredential" WHERE "id" = ${credentialId} FOR UPDATE`;
    const credential = await tx.emailIntegrationCredential.findUnique({
      where: { id: credentialId },
      select: { provider: true, userId: true, email: true, accessToken: true, refreshToken: true },
    });
    const revocations = [];
    if (credential?.provider === EmailProvider.GMAIL) {
      const token = credential.refreshToken ?? credential.accessToken;
      if (credential.email !== null || token !== null) {
        const job = await tx.googleDataPurge.create({
          data: {
            userId: credential.userId,
            email: credential.email?.toLowerCase() ?? null,
            revocationToken: token === null ? null : encryptGoogleToken(token),
          },
        });
        revocations.push({ id: job.id, token });
      }
    }
    const deleted = await tx.emailIntegrationCredential.delete({ where: { id: credentialId } });
    return { deleted, revocations };
  });
  await revokeQueuedGoogleGrants(revocations);
  return deleted;
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
  const credential = await prisma.emailIntegrationCredential.findFirst({
    where: {
      userId,
      provider: EmailProvider.GMAIL,
      accessToken: { not: null },
      scopes: { hasEvery: [...GOOGLE_OAUTH_SCOPES] },
      email: fromEmail,
    },
    include: {
      integration: true,
    },
  });
  return credential === null
    ? null
    : {
        ...credential,
        accessToken:
          credential.accessToken === null ? null : readGoogleToken(credential.accessToken),
        refreshToken:
          credential.refreshToken === null ? null : readGoogleToken(credential.refreshToken),
      };
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
      accessToken: encryptGoogleToken(data.accessToken),
      expiresAt: data.expiresAt,
      ...(data.refreshToken !== undefined &&
        data.refreshToken !== '' && { refreshToken: encryptGoogleToken(data.refreshToken) }),
    },
  });
}
