import { prisma } from '../../providers/database';
import { SAVED_PASSWORD_BROWSER_SOURCE } from './config';

export async function userExists(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { userId }, select: { userId: true } });
  return user !== null;
}

/**
 * Upserts one saved browser password for the fixture origin. Rows are keyed by
 * the per-site origin, so a retried fixture call converges on the same rows
 * instead of duplicating them.
 */
export async function upsertSavedPassword(params: {
  userId: string;
  origin: string;
  username: string;
  encryptedPassword: string;
  dateLastUsedMs: number;
}): Promise<string> {
  const dateLastUsed = BigInt(params.dateLastUsedMs);
  const row = await prisma.browserPassword.upsert({
    where: {
      userId_origin_username: {
        userId: params.userId,
        origin: params.origin,
        username: params.username,
      },
    },
    create: {
      userId: params.userId,
      origin: params.origin,
      username: params.username,
      encryptedPassword: params.encryptedPassword,
      dateLastUsed,
      dateCreated: dateLastUsed,
      browserSource: SAVED_PASSWORD_BROWSER_SOURCE,
    },
    update: {
      encryptedPassword: params.encryptedPassword,
      dateLastUsed,
      disabledAt: null,
      disabledReason: null,
    },
    select: { id: true },
  });
  return row.id;
}

export async function findSavedPasswordStates(ids: string[]) {
  if (ids.length === 0) return [];
  return prisma.browserPassword.findMany({
    where: { id: { in: ids } },
    select: { id: true, disabledAt: true, disabledReason: true },
  });
}

export async function deleteFixtureCredentials(params: {
  userId: string;
  origin: string;
  realm: string;
}): Promise<{ passwords: number; mintedAccounts: number }> {
  const [passwords, mintedAccounts] = await Promise.all([
    prisma.browserPassword.deleteMany({
      where: {
        userId: params.userId,
        origin: params.origin,
        browserSource: SAVED_PASSWORD_BROWSER_SOURCE,
      },
    }),
    prisma.mintedAccount.deleteMany({
      where: { userId: params.userId, authRealm: params.realm },
    }),
  ]);
  return { passwords: passwords.count, mintedAccounts: mintedAccounts.count };
}
