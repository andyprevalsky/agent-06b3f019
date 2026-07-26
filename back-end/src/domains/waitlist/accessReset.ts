export interface WaitlistAccessUser {
  userId: string;
  isAnonymous: boolean;
  usedInviteCode: number | null;
  offWaitlistAt: Date | null;
}

export interface WaitlistAccessResetPlan {
  targetUserIds: string[];
  protectedUserIds: string[];
  protectedUsersNeedingAccess: string[];
  targetsNeedingReset: number;
}

export function planWaitlistAccessReset(
  users: WaitlistAccessUser[],
  protectedUserIds: ReadonlySet<string>
): WaitlistAccessResetPlan {
  const protectedUsers = users
    .filter((user) => !user.isAnonymous && protectedUserIds.has(user.userId))
    .sort((left, right) => left.userId.localeCompare(right.userId));
  const foundProtectedIds = new Set(protectedUsers.map((user) => user.userId));
  const missingProtectedIds = [...protectedUserIds]
    .filter((userId) => !foundProtectedIds.has(userId))
    .sort();
  if (missingProtectedIds.length > 0) {
    throw new Error(`Missing protected users: ${missingProtectedIds.join(', ')}`);
  }

  const targets = users
    .filter((user) => !user.isAnonymous && !protectedUserIds.has(user.userId))
    .sort((left, right) => left.userId.localeCompare(right.userId));

  return {
    targetUserIds: targets.map((user) => user.userId),
    protectedUserIds: protectedUsers.map((user) => user.userId),
    protectedUsersNeedingAccess: protectedUsers
      .filter((user) => user.usedInviteCode === null)
      .map((user) => user.userId),
    targetsNeedingReset: targets.filter(
      (user) => user.usedInviteCode !== null || user.offWaitlistAt !== null
    ).length,
  };
}
