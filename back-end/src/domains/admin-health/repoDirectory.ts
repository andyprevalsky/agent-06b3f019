/**
 * Admin user-directory queries — the searchable union of real accounts and real
 * waitlist signups that backs the admin Users page and the always-on account
 * switcher.
 *
 * Split out of repo.ts to keep each repo file inside the strict per-file line
 * budget. Peer repo imports are permitted by the layered-architecture rules.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '../../providers/database';
import { realWaitlistPersonSql } from '../../providers/waitlistIdentity';

export interface DirectoryPersonRow {
  userId: string | null;
  waitlistId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  joinedAt: Date;
  invitedAt: Date | null;
  usedInviteCode: number | null;
  offWaitlistAt: Date | null;
}

export interface DirectoryPeoplePage {
  rows: DirectoryPersonRow[];
  total: number;
}

/**
 * Escape a user-supplied search term for a LIKE/ILIKE pattern so `%` and `_`
 * are matched literally instead of acting as wildcards.
 */
function likePattern(term: string): string {
  return '%' + term.replace(/[\\%_]/g, (char) => '\\' + char) + '%';
}

/**
 * The two halves of the directory: real accounts and waitlist signups, keyed on
 * the last 10 phone digits so differently-formatted numbers still line up, and
 * falling back to the lowercased email when a side carries no phone at all.
 *
 * The email fallback is what lets email-only signups (the public landing form
 * collects no phone) appear here; they previously vanished entirely. An
 * email-only waitlist row still cannot merge into a phone-bearing account —
 * that account keys on its digits — so it stays a distinct directory entry
 * until it signs up with a phone.
 *
 * Waitlist rows are de-duplicated per key (oldest wins) so a person who signed
 * up twice can't split the account they belong to across two rows.
 */
const DIRECTORY_CTE = Prisma.sql`
  WITH acct AS (
    SELECT
      u."userId" AS user_id,
      NULLIF(btrim(COALESCE(u."name", '')), '') AS name,
      NULLIF(btrim(COALESCE(u."email", '')), '') AS email,
      NULLIF(btrim(COALESCE(u."phone", '')), '') AS phone,
      u."createdAt" AS joined_at,
      u."usedInviteCode" AS used_invite_code,
      u."offWaitlistAt" AS off_waitlist_at,
      NULLIF(RIGHT(regexp_replace(COALESCE(u."phone", ''), '[^0-9]', '', 'g'), 10), '') AS digits,
      COALESCE(
        NULLIF(RIGHT(regexp_replace(COALESCE(u."phone", ''), '[^0-9]', '', 'g'), 10), ''),
        'email:' || lower(NULLIF(btrim(COALESCE(u."email", '')), ''))
      ) AS match_key
    FROM "User" u
    -- Phone-bearing rows count even when isAnonymous is true: the core dev/test
    -- account (1f85ff25…, +19729777432) is flagged anonymous but is a real
    -- person, and dropping it is the same bug that once made the user metric
    -- read 1 instead of 3. Phone-less anonymous bootstrap rows stay excluded.
    WHERE u."isAnonymous" = false
       OR NULLIF(btrim(COALESCE(u."phone", '')), '') IS NOT NULL
  ),
  wl AS (
    SELECT DISTINCT ON (
      COALESCE(
        NULLIF(RIGHT(regexp_replace(COALESCE(w."phone", ''), '[^0-9]', '', 'g'), 10), ''),
        'email:' || lower(NULLIF(btrim(COALESCE(w."email", '')), ''))
      )
    )
      w."id" AS waitlist_id,
      NULLIF(btrim(COALESCE(w."name", '')), '') AS name,
      NULLIF(btrim(COALESCE(w."email", '')), '') AS email,
      NULLIF(btrim(COALESCE(w."phone", '')), '') AS phone,
      w."created_at" AS joined_at,
      w."invited_at" AS invited_at,
      NULLIF(RIGHT(regexp_replace(COALESCE(w."phone", ''), '[^0-9]', '', 'g'), 10), '') AS digits,
      COALESCE(
        NULLIF(RIGHT(regexp_replace(COALESCE(w."phone", ''), '[^0-9]', '', 'g'), 10), ''),
        'email:' || lower(NULLIF(btrim(COALESCE(w."email", '')), ''))
      ) AS match_key
    FROM "Waitlist" w
    WHERE ${realWaitlistPersonSql('w')}
    ORDER BY
      COALESCE(
        NULLIF(RIGHT(regexp_replace(COALESCE(w."phone", ''), '[^0-9]', '', 'g'), 10), ''),
        'email:' || lower(NULLIF(btrim(COALESCE(w."email", '')), ''))
      ),
      w."created_at" ASC,
      w."id" ASC
  ),
  merged AS (
    SELECT
      acct.user_id,
      wl.waitlist_id,
      COALESCE(acct.name, wl.name) AS name,
      COALESCE(acct.email, wl.email) AS email,
      COALESCE(acct.phone, wl.phone) AS phone,
      COALESCE(acct.joined_at, wl.joined_at) AS joined_at,
      wl.invited_at AS invited_at,
      acct.used_invite_code,
      acct.off_waitlist_at,
      COALESCE(acct.digits, wl.digits) AS digits
    FROM acct
    FULL OUTER JOIN wl ON acct.match_key = wl.match_key
  )
`;

function directoryFilter(search: string): Prisma.Sql {
  const term = search.trim();
  if (term === '') return Prisma.sql`TRUE`;

  const text = likePattern(term);
  const digits = term.replace(/\D/g, '');
  const clauses = [
    Prisma.sql`m.name ILIKE ${text} ESCAPE '\\'`,
    Prisma.sql`m.email ILIKE ${text} ESCAPE '\\'`,
    Prisma.sql`m.user_id = ${term}`,
  ];
  if (digits !== '') {
    // Search digits are normalized the same way the join key is, so "+1 (972)
    // 977-7432", "9729777432", and "7432" all hit the same row.
    clauses.push(Prisma.sql`m.digits LIKE ${'%' + digits.slice(-10) + '%'}`);
  }
  return Prisma.sql`(${Prisma.join(clauses, ' OR ')})`;
}

/**
 * One bounded page of the admin user directory, searchable by name, email,
 * phone, or userId. Newest first.
 *
 * Bounded by construction — pageSize is capped upstream (parsePeoplePagination),
 * so this returns O(page) rows regardless of directory size, and it is only ever
 * reachable from the admin-gated dashboard.
 */
export async function findDirectoryPeople(params: {
  skip: number;
  take: number;
  search: string;
}): Promise<DirectoryPeoplePage> {
  const filter = directoryFilter(params.search);
  const [rows, total] = await prisma.$transaction(
    [
      prisma.$queryRaw<DirectoryPersonRow[]>`
        ${DIRECTORY_CTE}
        SELECT
          m.user_id AS "userId",
          m.waitlist_id AS "waitlistId",
          m.name AS "name",
          m.email AS "email",
          m.phone AS "phone",
          m.joined_at AS "joinedAt",
          m.invited_at AS "invitedAt",
          m.used_invite_code AS "usedInviteCode",
          m.off_waitlist_at AS "offWaitlistAt"
        FROM merged m
        WHERE ${filter}
        ORDER BY m.joined_at DESC, COALESCE(m.user_id, m.waitlist_id) DESC
        OFFSET ${params.skip}
        LIMIT ${params.take}
      `,
      prisma.$queryRaw<Array<{ count: number }>>`
        ${DIRECTORY_CTE}
        SELECT COUNT(*)::int AS "count"
        FROM merged m
        WHERE ${filter}
      `,
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  return { rows, total: total[0]?.count ?? 0 };
}

/** Subset of the given userIds that currently hold an unexpired subscription. */
export async function findActiveSubscriptionUserIds(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const subs = await prisma.subscription.findMany({
    where: { userId: { in: userIds }, currentPeriodEnd: { gt: new Date() } },
    select: { userId: true },
  });
  return new Set(subs.map((sub) => sub.userId));
}

export interface ImpersonationTargetRecord {
  userId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** The identity an admin is switching into, or null when no such account exists. */
export async function findImpersonationTarget(
  userId: string
): Promise<ImpersonationTargetRecord | null> {
  return prisma.user.findUnique({
    where: { userId },
    select: { userId: true, name: true, email: true, phone: true },
  });
}
