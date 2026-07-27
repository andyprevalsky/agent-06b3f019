/**
 * Admin user directory + account switching.
 *
 * The directory is the union of real accounts and phone-bearing waitlist
 * signups (see repo.findDirectoryPeople) so one searchable surface covers both
 * "who is in the product" and "who is waiting to get in". Rows that resolve to a
 * real account can be switched into; rows that carry a waitlist id can be
 * invited.
 *
 * Switching mints a normal user session for the target with the SAME minter the
 * OTP flow uses, so every downstream service sees an ordinary authenticated
 * user. The admin's own session is retained client-side, which is what makes the
 * switch reversible.
 */

import { createLogger } from '../../providers/logger';
import { generateSupabaseSession } from '../../providers/sessionTokens';

import { ADMIN_USER_IDS } from './config';
import * as repo from './repoDirectory';
import { DEFAULT_PEOPLE_PAGE_SIZE, type PeoplePagination } from './service.pagination';
import type {
  AdminDirectoryPerson,
  AdminDirectoryResponse,
  AdminImpersonationResponse,
} from './types';

const log = createLogger('AdminHealthUsers');

/** Longest search term accepted, so a pathological query can't drive a huge scan. */
const MAX_SEARCH_LENGTH = 200;

export class DirectorySearchError extends Error {
  constructor() {
    super(`search must be a string of at most ${MAX_SEARCH_LENGTH} characters`);
    this.name = 'DirectorySearchError';
  }
}

export class ImpersonationTargetNotFoundError extends Error {
  constructor() {
    super('No account exists for that user');
    this.name = 'ImpersonationTargetNotFoundError';
  }
}

export class ImpersonationTargetInvalidError extends Error {
  constructor() {
    super('userId must be a non-empty string');
    this.name = 'ImpersonationTargetInvalidError';
  }
}

export function parseDirectorySearch(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_SEARCH_LENGTH) {
    throw new DirectorySearchError();
  }
  return value.trim();
}

/** Stable React key / dedup key for a merged directory row. */
function directoryKey(row: repo.DirectoryPersonRow): string {
  return row.userId !== null ? `user:${row.userId}` : `waitlist:${row.waitlistId ?? 'unknown'}`;
}

/** Return one bounded, searchable page of the merged account + waitlist directory. */
export async function getDirectoryPeople(
  pagination: PeoplePagination = { page: 1, pageSize: DEFAULT_PEOPLE_PAGE_SIZE },
  search = ''
): Promise<AdminDirectoryResponse> {
  const { rows, total } = await repo.findDirectoryPeople({
    skip: (pagination.page - 1) * pagination.pageSize,
    take: pagination.pageSize,
    search,
  });

  const userIds = rows.map((row) => row.userId).filter((id): id is string => id !== null);
  const subscribedUserIds = await repo.findActiveSubscriptionUserIds(userIds);

  const people: AdminDirectoryPerson[] = rows.map((row) => {
    const hasAccount = row.userId !== null;
    // Matches the real gate: a redeemed invite code OR an active subscription
    // clears it (offWaitlistAt alone does not).
    const isGated =
      hasAccount &&
      row.usedInviteCode === null &&
      !subscribedUserIds.has(row.userId as string) &&
      row.waitlistId !== null;
    return {
      key: directoryKey(row),
      userId: row.userId,
      waitlistId: row.waitlistId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      joinedAt: row.joinedAt.toISOString(),
      invitedAt: row.invitedAt === null ? null : row.invitedAt.toISOString(),
      hasAccount,
      hasSubscription: hasAccount && subscribedUserIds.has(row.userId as string),
      isGated,
      isAdmin: row.userId !== null && ADMIN_USER_IDS.has(row.userId),
    };
  });

  return {
    people,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
    search,
  };
}

/**
 * Mint a session for `targetUserId` on behalf of an admin who has already
 * cleared assertCanViewAdminHealth. Returns the target's identity alongside the
 * session so the client can label the switched-into account without a second
 * round trip.
 */
export async function impersonateUser(params: {
  actorUserId: string;
  targetUserId: unknown;
}): Promise<AdminImpersonationResponse> {
  if (typeof params.targetUserId !== 'string' || params.targetUserId.trim() === '') {
    throw new ImpersonationTargetInvalidError();
  }
  const targetUserId = params.targetUserId.trim();

  const target = await repo.findImpersonationTarget(targetUserId);
  if (target === null) throw new ImpersonationTargetNotFoundError();

  const session = generateSupabaseSession(target.userId, target.phone ?? '');

  log.warn('Admin switched into another account', {
    actorUserId: params.actorUserId,
    targetUserId: target.userId,
  });

  return {
    session,
    user: {
      userId: target.userId,
      name: target.name,
      email: target.email,
      phone: target.phone,
      isAdmin: ADMIN_USER_IDS.has(target.userId),
    },
  };
}
