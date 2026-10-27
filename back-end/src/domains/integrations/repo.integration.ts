/** Single-integration CRUD kept separate from the browser-data repository. */

import { EmailProvider, type Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { encryptGoogleToken } from '../../providers/googleCredentials';
import { revokeQueuedGoogleGrants } from '../../services/integrations/googleDisconnect';

export async function findIntegrationByUserAndName(userId: string, name: string) {
  return prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name, accountId: '' } },
  });
}

export async function updateIntegration(
  integrationId: string,
  data: Prisma.IntegrationUpdateInput
) {
  return prisma.integration.update({ where: { id: integrationId }, data });
}

export async function deleteIntegration(integrationId: string) {
  const { integration, revocations } = await runTransactionWithRetry(async (tx) => {
    const credentials = await tx.emailIntegrationCredential.findMany({
      where: { integrationId, provider: EmailProvider.GMAIL },
      select: { userId: true, email: true, accessToken: true, refreshToken: true },
    });
    const revocations = [];
    for (const credential of credentials) {
      const token = credential.refreshToken ?? credential.accessToken;
      if (credential.email === null && token === null) continue;
      const job = await tx.googleDataPurge.create({
        data: {
          userId: credential.userId,
          email: credential.email?.toLowerCase() ?? null,
          revocationToken: token === null ? null : encryptGoogleToken(token),
        },
      });
      revocations.push({ id: job.id, token });
    }
    // Queued history parts hold message payloads; they must not outlive or be
    // processed after their integration.
    await tx.messagingUploadJob.deleteMany({ where: { integrationId } });
    const integration = await tx.integration.delete({ where: { id: integrationId } });
    return { integration, revocations };
  });
  await revokeQueuedGoogleGrants(revocations);
  return integration;
}

export async function persistRecoveredIntegrationAccountId(
  userId: string,
  name: 'claude_code' | 'gpt_code',
  recoveredAccountId: string
): Promise<void> {
  const conflict = await prisma.integration.findFirst({
    where: { userId, name, accountId: recoveredAccountId },
    select: { id: true },
  });
  if (conflict !== null) return;
  await prisma.integration.updateMany({
    where: { userId, name, accountId: '' },
    data: { accountId: recoveredAccountId },
  });
}
