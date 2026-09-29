/** Single-integration CRUD kept separate from the browser-data repository. */

import { EmailProvider, type Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { revokeGoogleGrant } from '../../providers/googleRevoke';

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
  const credentials = await prisma.emailIntegrationCredential.findMany({
    where: { integrationId, provider: EmailProvider.GMAIL },
    select: { userId: true, email: true, accessToken: true, refreshToken: true },
  });
  for (const credential of credentials) {
    await revokeGoogleGrant(credential.refreshToken, credential.accessToken);
  }
  return runTransactionWithRetry(async (tx) => {
    for (const credential of credentials) {
      if (credential.email !== null) {
        await tx.googleDataPurge.create({
          data: { userId: credential.userId, email: credential.email.toLowerCase() },
        });
      }
    }
    return tx.integration.delete({ where: { id: integrationId } });
  });
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
