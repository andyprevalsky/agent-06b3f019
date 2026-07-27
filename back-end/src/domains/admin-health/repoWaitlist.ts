/**
 * Waitlist-people queries — the actionable phone-bearing signup list, its
 * account/gate joins, and the invite stamp.
 *
 * Split out of repo.ts to keep each repo file inside the strict per-file line
 * budget; repo.ts re-exports these so existing consumers are unaffected.
 */

import { prisma } from '../../providers/database';
import { Prisma } from '@prisma/client';

export interface WaitlistPersonRow {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  variant: string | null;
  createdAt: Date;
  invitedAt: Date | null;
}

export interface WaitlistPeoplePage {
  rows: WaitlistPersonRow[];
  total: number;
}

/**
 * One bounded page of actionable waitlist people — the same phone-bearing
 * population the signup metric counts. Newest first, with id as the stable
 * tie-breaker. Email-only legacy rows (no phone) are excluded because they
 * can't be texted.
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
          "email",
          "phone",
          "variant",
          "created_at" AS "createdAt",
          "invited_at" AS "invitedAt"
        FROM "Waitlist"
        WHERE "phone" IS NOT NULL
          AND regexp_replace("phone", '[[:space:]]', '', 'g') <> ''
        ORDER BY "created_at" DESC, "id" DESC
        OFFSET ${params.skip}
        LIMIT ${params.take}
      `,
      prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM "Waitlist"
        WHERE "phone" IS NOT NULL
          AND regexp_replace("phone", '[[:space:]]', '', 'g') <> ''
      `,
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  return {
    rows,
    total: total[0]?.count ?? 0,
  };
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
  if (row === null || (row.phone ?? '').trim() === '') return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone as string,
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
