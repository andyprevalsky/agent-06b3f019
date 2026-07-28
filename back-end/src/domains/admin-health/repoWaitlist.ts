/**
 * Waitlist-people queries — the real-signup list, its account/gate joins, and
 * the invite stamp.
 *
 * Split out of repo.ts to keep each repo file inside the strict per-file line
 * budget; repo.ts re-exports these so existing consumers are unaffected.
 */

import { prisma } from '../../providers/database';
import { isRealWaitlistPerson, realWaitlistPersonSql } from '../../providers/waitlistIdentity';
import { Prisma } from '@prisma/client';

export interface WaitlistPersonRow {
  id: string;
  name: string;
  email: string | null;
  /** Null for email-only signups — the public landing form collects no phone. */
  phone: string | null;
  variant: string | null;
  createdAt: Date;
  invitedAt: Date | null;
}

export interface WaitlistPeoplePage {
  rows: WaitlistPersonRow[];
  total: number;
}

/**
 * One bounded page of real waitlist people — the same population the signup
 * metric counts. Newest first, with id as the stable tie-breaker.
 *
 * A person qualifies on email OR phone. The prior filter required a phone,
 * which was a stand-in for "not fixture junk" and silently hid every email-only
 * signup; fixtures are now excluded by classification instead.
 */
export async function findWaitlistPeople(params: {
  skip: number;
  take: number;
}): Promise<WaitlistPeoplePage> {
  const [rows, total] = await prisma.$transaction(
    [
      prisma.$queryRaw<WaitlistPersonRow[]>`
        SELECT
          "id",
          "name",
          NULLIF(btrim(COALESCE("email", '')), '') AS "email",
          NULLIF(btrim(COALESCE("phone", '')), '') AS "phone",
          "variant",
          "created_at" AS "createdAt",
          "invited_at" AS "invitedAt"
        FROM "Waitlist"
        WHERE ${realWaitlistPersonSql()}
        ORDER BY "created_at" DESC, "id" DESC
        OFFSET ${params.skip}
        LIMIT ${params.take}
      `,
      prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM "Waitlist"
        WHERE ${realWaitlistPersonSql()}
      `,
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  return {
    rows,
    total: total[0]?.count ?? 0,
  };
}

function nullIfBlank(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export async function findWaitlistPersonById(id: string): Promise<WaitlistPersonRow | null> {
  const row = await prisma.waitlist.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      variant: true,
      createdAt: true,
      invitedAt: true,
    },
  });
  if (row === null || !isRealWaitlistPerson(row)) return null;
  return {
    id: row.id,
    name: row.name,
    email: nullIfBlank(row.email),
    phone: nullIfBlank(row.phone),
    variant: row.variant,
    createdAt: row.createdAt,
    invitedAt: row.invitedAt,
  };
}

export async function findUserEmailById(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { email: true },
  });
  const email = user?.email?.trim() ?? '';
  return email === '' ? null : email;
}

export interface AccountGateRecord {
  phone: string;
  usedInviteCode: number | null;
  hasActiveSubscription: boolean;
}

function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/**
 * Accounts matching any of the given phone numbers, with gate state. Matches on
 * canonical digits ('+digits' or bare 'digits') so a differently-formatted
 * User.phone still resolves, and reports whether each holds an active
 * subscription (which clears the invite gate).
 */
export async function findAccountsByPhones(phones: string[]): Promise<AccountGateRecord[]> {
  const candidates = new Set<string>();
  for (const phone of phones) {
    const digits = phoneDigits(phone);
    if (digits === '') continue;
    candidates.add('+' + digits);
    candidates.add(digits);
  }
  if (candidates.size === 0) return [];

  const users = await prisma.user.findMany({
    where: { phone: { in: Array.from(candidates) } },
    select: { userId: true, phone: true, usedInviteCode: true },
  });
  const userIds = users.map((user) => user.userId);
  const activeSubs =
    userIds.length === 0
      ? []
      : await prisma.subscription.findMany({
          where: { userId: { in: userIds }, currentPeriodEnd: { gt: new Date() } },
          select: { userId: true },
        });
  const activeSubUserIds = new Set(activeSubs.map((sub) => sub.userId));

  return users
    .filter((user) => (user.phone ?? '').trim() !== '')
    .map((user) => ({
      phone: user.phone as string,
      usedInviteCode: user.usedInviteCode,
      hasActiveSubscription: activeSubUserIds.has(user.userId),
    }));
}

export async function markWaitlistInvited(id: string, invitedAt: Date): Promise<void> {
  await prisma.waitlist.update({ where: { id }, data: { invitedAt } });
}
