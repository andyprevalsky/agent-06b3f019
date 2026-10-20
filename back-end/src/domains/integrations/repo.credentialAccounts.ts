/**
 * Saved-login and passkey rows addressed as integration accounts (plan row I7).
 *
 *   `<source>_passwords` / accountId = browserProfile ('' = no profile)
 *        → BrowserPassword rows (userId, browserSource ∈ sources, browserProfile)
 *   `<source>_passkeys`  / accountId '' (one account per source)
 *        → PasskeyCredential rows (userId, browserSource)
 *
 * Deleting an account removes its rows and its Integration row in one
 * transaction; other sources and profiles are untouched. Every statement is
 * scoped to one userId and uses the (userId, …) indexes.
 */

import { prisma, runTransactionWithRetry } from '../../providers/database';

export interface CredentialAccountDeletion {
  credentials: number;
  integrationRows: number;
}

export async function countPasswordsForProfile(
  userId: string,
  browserSources: string[],
  browserProfile: string
): Promise<number> {
  return prisma.browserPassword.count({
    where: { userId, browserSource: { in: browserSources }, browserProfile },
  });
}

export async function deletePasswordAccountRows(params: {
  userId: string;
  provider: string;
  browserSources: string[];
  browserProfile: string;
}): Promise<CredentialAccountDeletion> {
  return runTransactionWithRetry(async (tx) => {
    const credentials = await tx.browserPassword.deleteMany({
      where: {
        userId: params.userId,
        browserSource: { in: params.browserSources },
        browserProfile: params.browserProfile,
      },
    });
    const rows = await tx.integration.deleteMany({
      where: { userId: params.userId, name: params.provider, accountId: params.browserProfile },
    });
    return { credentials: credentials.count, integrationRows: rows.count };
  });
}

export async function deletePasskeyAccountRows(params: {
  userId: string;
  provider: string;
  browserSource: string;
}): Promise<CredentialAccountDeletion> {
  return runTransactionWithRetry(async (tx) => {
    const credentials = await tx.passkeyCredential.deleteMany({
      where: { userId: params.userId, browserSource: params.browserSource },
    });
    const rows = await tx.integration.deleteMany({
      where: { userId: params.userId, name: params.provider, accountId: '' },
    });
    return { credentials: credentials.count, integrationRows: rows.count };
  });
}
