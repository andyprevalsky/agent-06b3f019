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

export type LocalUserModel = {
  upsert(args: {
    where: { userId: string };
    create: RemoteUserRecord;
    update: Omit<RemoteUserRecord, 'id'>;
  }): Promise<unknown>;
};

export async function syncUserRecord(
  remoteUser: RemoteUserModel,
  localUser: LocalUserModel,
  userId: string
): Promise<number> {
  const user = await remoteUser.findUnique({
    where: { userId },
    select: REMOTE_USER_SELECT,
  });
  if (!user) return 0;
  const { id, ...rest } = user;
  void id;
  await localUser.upsert({
    where: { userId },
    create: user,
    update: rest,
  });
  return 1;
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
