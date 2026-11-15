/**
 * SQL authority for shared meeting notes (documents) and Plaid transactions, applied
 * before matching and LIMIT. Every shared part revalidates its share at the read.
 *
 *   documents     own rows  +  granola/fireflies grants: owner rows of that provider's layers,
 *                              while the pinned account email still matches the integration
 *   transactions  own rows  +  plaid grants, ONLY under an explicit team_id/owner_user_id:
 *                              owner rows of exactly the shared, still ACTIVE PlaidItem
 */
import { Prisma } from '@prisma/client';
import { agentAccountId, MEETING_NOTE_PROVIDERS } from '../../providers/teamAccess';
import { meetingSources } from '../../services/integrations/meetingDocuments';
import { includesOwnData, type TeamSearchScope } from './teamAccess';
import {
  liveShareExists,
  rowOwnership,
  type MessageAccess,
  type SharedGrant,
} from './teamAccessRepo';
import type { GrepOwnership } from './types.message';

export type TableAccess = MessageAccess;

export const OUTSIDE_SCOPE_NOTICE = (source: string) =>
  `${source}: private source is outside this sharing scope.`;
export const PLAID_EXPLICIT_SCOPE_NOTICE =
  'transactions: a shared Plaid account is searched only with an explicit team_id or owner_user_id.';

const MEETING = new Set<string>(MEETING_NOTE_PROVIDERS);

function requestedAccount(search: TeamSearchScope): string | undefined {
  return search.accountId?.toLowerCase();
}

/** Meeting-notes grants this scope may read (account filter applied). */
export function documentAccess(
  userId: string,
  search: TeamSearchScope,
  grants: SharedGrant[]
): TableAccess {
  const requested = requestedAccount(search);
  return {
    userId,
    search,
    grants: grants.filter(
      (grant) =>
        MEETING.has(grant.provider) &&
        grant.accountId === '' &&
        (requested === undefined || requested === agentAccountId(grant))
    ),
  };
}

/** Own documents and live meeting-notes shares; null when this scope can read none. */
export function documentAccessPredicate(access: TableAccess): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  const requested = requestedAccount(access.search);
  if (includesOwnData(access.userId, access.search)) {
    if (requested === undefined) parts.push(Prisma.sql`d."userId" = ${access.userId}`);
    else if (MEETING.has(requested))
      parts.push(
        Prisma.sql`(d."userId" = ${access.userId} AND d.source IN (${Prisma.join(meetingSources(requested))}))`
      );
  }
  for (const grant of access.grants) {
    // Pinned: a different meeting-notes account signed in under the same row ends the share.
    const pinned = Prisma.sql`i."accountId" = ''
      AND s."accountEmail" IS NOT DISTINCT FROM ${grant.accountEmail}
      AND s."accountEmail" IS NOT DISTINCT FROM NULLIF(lower(btrim(i."accountEmail")), '')`;
    parts.push(Prisma.sql`(d."userId" = ${grant.ownerUserId}
      AND d.source IN (${Prisma.join(meetingSources(grant.provider))})
      AND ${liveShareExists(access.userId, grant, pinned)})`);
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : null;
}

export function documentOwnership(
  access: TableAccess,
  row: { userId: string; source: string }
): GrepOwnership {
  const provider = MEETING_NOTE_PROVIDERS.find((name) => meetingSources(name).includes(row.source));
  return rowOwnership(access, {
    ownerUserId: row.userId,
    provider: provider ?? row.source,
    accountId: provider ?? null,
  });
}

/**
 * Plaid grants this scope may read. Financial data never merges into a reader's default
 * scope: shared items are read only when the request names a team or another owner.
 */
export function transactionAccess(
  userId: string,
  search: TeamSearchScope,
  grants: SharedGrant[]
): TableAccess & { notice?: string } {
  const plaid = grants.filter((grant) => grant.provider === 'plaid' && grant.accountId !== '');
  const account = search.accountId;
  if (includesOwnData(userId, search)) {
    const named = account !== undefined && plaid.some((grant) => grant.accountId === account);
    return {
      userId,
      search,
      grants: [],
      ...(named ? { notice: PLAID_EXPLICIT_SCOPE_NOTICE } : {}),
    };
  }
  return {
    userId,
    search,
    grants: plaid.filter((grant) => account === undefined || grant.accountId === account),
  };
}

/** Own transactions and live Plaid item shares; null when this scope can read none. */
export function transactionAccessPredicate(access: TableAccess): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  const account = access.search.accountId;
  if (includesOwnData(access.userId, access.search)) {
    parts.push(
      account === undefined
        ? Prisma.sql`t."userId" = ${access.userId}`
        : Prisma.sql`(t."userId" = ${access.userId} AND t."plaidItemId" = ${account})`
    );
  }
  for (const grant of access.grants) {
    const item = Prisma.sql`EXISTS (
      SELECT 1 FROM "PlaidItem" pi WHERE pi.id = s."accountId" AND pi."userId" = i."userId"
        AND pi."integrationId" = i.id AND pi.status::text = 'ACTIVE'
    )`;
    parts.push(Prisma.sql`(t."userId" = ${grant.ownerUserId} AND t."plaidItemId" = ${grant.accountId}
      AND ${liveShareExists(access.userId, grant, item)})`);
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : null;
}

export function transactionOwnership(
  access: TableAccess,
  row: { userId: string; plaidItemId: string }
): GrepOwnership {
  return rowOwnership(access, {
    ownerUserId: row.userId,
    provider: 'plaid',
    accountId: row.plaidItemId,
  });
}
