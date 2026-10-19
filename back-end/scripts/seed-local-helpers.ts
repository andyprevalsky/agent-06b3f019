import type { Prisma } from '@prisma/client';

export const REMOTE_USER_SELECT = {
  id: true,
  userId: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  createdAt: true,
  updatedAt: true,
  inviteCode: true,
  inviteCodeUses: true,
  usedInviteCode: true,
  encryptedPaymentInformation: true,
  phone: true,
  isAnonymous: true,
  onboardingCompletedAt: true,
  systemName: true,
  profilePicture: true,
  customSystemPrompt: true,
  voicePreferenceId: true,
} as const satisfies Prisma.UserSelect;

type RemoteUserRecord = Prisma.UserGetPayload<{ select: typeof REMOTE_USER_SELECT }>;

export type RemoteUserModel = {
  findUnique(args: {
    where: { userId: string };
    select: typeof REMOTE_USER_SELECT;
  }): Promise<RemoteUserRecord | null>;
};

type UserIdentityRecord = {
  id: string;
  userId: string;
};

type UserIdentityModel<T extends UserIdentityRecord> = {
  upsert(args: {
    where: { userId: string };
    create: T;
    update: Partial<Omit<T, 'id'>>;
  }): Promise<unknown>;
};

export type LocalUserModel = UserIdentityModel<RemoteUserRecord>;

export type ScopedUserRecord = {
  id: string;
  userId: string;
  phone: string | null;
  usedInviteCode: number | null;
};

export type ScopedLocalUserModel = UserIdentityModel<ScopedUserRecord>;

export type ScopedRemoteUserModel = {
  findMany(args: {
    where: { phone: { in: string[] } };
    select: {
      id: true;
      userId: true;
      phone: true;
      usedInviteCode: true;
    };
  }): Promise<ScopedUserRecord[]>;
};

async function syncUserRecordsByIdentity<T extends UserIdentityRecord>(
  localUser: UserIdentityModel<T>,
  users: readonly T[],
  preserveExisting = false
): Promise<number> {
  for (const user of users) {
    const { id: remoteId, ...rest } = user;
    void remoteId;
    await localUser.upsert({
      where: { userId: user.userId },
      create: user,
      update: preserveExisting ? {} : rest,
    });
  }
  return users.length;
}

export async function syncWaitlistAccounts(
  remoteUser: ScopedRemoteUserModel,
  localUser: ScopedLocalUserModel,
  phones: string[]
): Promise<number> {
  const users = await remoteUser.findMany({
    where: { phone: { in: phones } },
    select: {
      id: true,
      userId: true,
      phone: true,
      usedInviteCode: true,
    },
  });
  return syncUserRecordsByIdentity(localUser, users);
}

export async function syncUserRecord(
  remoteUser: RemoteUserModel,
  localUser: LocalUserModel,
  userId: string,
  preserveExisting = false
): Promise<number> {
  const user = await remoteUser.findUnique({
    where: { userId },
    select: REMOTE_USER_SELECT,
  });
  if (!user) return 0;
  return syncUserRecordsByIdentity(localUser, [user], preserveExisting);
}

/** Prisma unique `where` for a P2002 `meta.target` list. */
export function uniqueConflictWhere(
  fields: string[],
  record: Record<string, unknown>
): Record<string, unknown> {
  if (fields.length === 1) {
    const field = fields[0];
    return { [field]: record[field] };
  }
  const compoundKey = fields.join('_');
  return { [compoundKey]: Object.fromEntries(fields.map((field) => [field, record[field]])) };
}

export async function runSyncStep(name: string, fn: () => Promise<number>): Promise<void> {
  try {
    const count = await fn();
    console.log(`  ✅ ${name}: ${count} synced`);
  } catch (err) {
    console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

export async function syncRowsWithConcurrency<T>(
  rows: readonly T[],
  concurrency: number,
  syncRow: (row: T) => Promise<unknown>,
  onBatchComplete?: (completed: number, total: number) => void
): Promise<number> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`sync concurrency must be a positive integer, got ${concurrency}`);
  }
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    await Promise.all(rows.slice(offset, offset + concurrency).map(syncRow));
    onBatchComplete?.(Math.min(offset + concurrency, rows.length), rows.length);
  }
  return rows.length;
}
