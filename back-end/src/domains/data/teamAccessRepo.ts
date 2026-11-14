/** SQL authority for shared communications, applied before matching and LIMIT. */
import { Prisma } from '@prisma/client';
import { resolveTeamDataAccess } from '../../providers/teamAccess';
import { includesOwnData, type TeamSearchScope } from './teamAccess';

export type SharedGrant = Awaited<ReturnType<typeof resolveTeamDataAccess>>[number];
export interface MessageAccess {
  userId: string;
  search: TeamSearchScope;
  grants: SharedGrant[];
}

export async function resolveMessageAccess(
  userId: string,
  search: TeamSearchScope
): Promise<MessageAccess> {
  const grants =
    search.ownerUserId === userId && search.teamId === undefined
      ? []
      : await resolveTeamDataAccess(userId, {
          teamId: search.teamId,
          ownerUserId: search.ownerUserId,
        });
  return {
    userId,
    search,
    grants: grants.filter(
      (grant) =>
        (grant.provider === 'gmail' && Boolean(grant.accountEmail?.trim())) ||
        (grant.provider === 'imessage' && grant.accountId === '')
    ),
  };
}

/** Canonical account address for rows: Gmail inbox email, or legacy iMessage ''. */
export function grantAccountId(grant: SharedGrant): string {
  return grant.provider === 'gmail' ? grant.accountEmail!.trim().toLowerCase() : '';
}

export function messageAccessPredicate(access: MessageAccess, alias = 'm'): Prisma.Sql {
  // Alias is chosen by this module's callers, never from a request.
  if (!['m', 'a'].includes(alias)) throw new Error('Invalid message SQL alias');
  const col = (name: string) => Prisma.raw(`${alias}."${name}"`);
  const parts: Prisma.Sql[] = [];
  if (includesOwnData(access.userId, access.search)) {
    const account = access.search.accountId;
    const accountFilter =
      account === undefined
        ? Prisma.empty
        : account === ''
          ? Prisma.sql`AND ${col('channel')}::text = 'IMESSAGE'`
          : Prisma.sql`AND ${col('channel')}::text = 'EMAIL' AND lower(${col('googleAccountEmail')}) = ${account.toLowerCase()}`;
    parts.push(Prisma.sql`(${col('userId')} = ${access.userId} ${accountFilter})`);
  }
  for (const grant of access.grants) {
    const account = grantAccountId(grant);
    if (access.search.accountId !== undefined && access.search.accountId.toLowerCase() !== account)
      continue;
    const provenance =
      grant.provider === 'gmail'
        ? Prisma.sql`${col('channel')}::text = 'EMAIL' AND lower(${col('googleAccountEmail')}) = ${account}`
        : Prisma.sql`${col('channel')}::text = 'IMESSAGE'`;
    // Revalidate at the actual read, including context queries. A revocation
    // between resolver and search cannot retain authority via a cached grant.
    parts.push(Prisma.sql`(${col('userId')} = ${grant.ownerUserId} AND ${provenance}
      AND EXISTS (
        SELECT 1 FROM "TeamIntegrationShare" s
        JOIN "Integration" i ON i.id = s."integrationId"
        JOIN "TeamMember" reader ON reader."teamId" = s."teamId"
        JOIN "TeamMember" owner ON owner."teamId" = s."teamId" AND owner."userId" = i."userId"
        WHERE s."teamId" = ${grant.teamId} AND s."integrationId" = ${grant.integrationId}
          AND reader."userId" = ${access.userId} AND reader.status = 'ACCEPTED'
          AND owner.status = 'ACCEPTED' AND i.status::text = 'CONNECTED'
          AND i."isActive" = true AND i.type::text = 'DATA_SOURCE'
          AND s."ownerUserId" = i."userId" AND s.provider = i.name
          AND i."userId" = ${grant.ownerUserId} AND i.name = ${grant.provider}
          AND s."accountId" = ${grant.accountId}
          AND ${grant.provider === 'gmail' ? Prisma.sql`lower(s."accountEmail") = ${account}` : Prisma.sql`TRUE`}
          AND ${
            grant.provider === 'gmail'
              ? Prisma.sql`EXISTS (
            SELECT 1 FROM "EmailIntegrationCredential" ec WHERE ec."integrationId" = i.id
              AND ec."userId" = i."userId" AND lower(ec.email) = ${account}
              AND ec.state = 'connected' AND lower(ec.provider::text) = i.name
          )`
              : Prisma.sql`i."accountId" = '' AND NOT EXISTS (
            SELECT 1 FROM "Integration" other WHERE other."userId" = i."userId"
              AND other.name = 'imessage' AND other.id <> i.id
          )`
          }
      ))`);
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : Prisma.sql`FALSE`;
}

export function messageOwnership(
  access: MessageAccess,
  row: { userId: string; channel: string; googleAccountEmail: string | null }
) {
  const account =
    row.channel === 'EMAIL'
      ? (row.googleAccountEmail?.toLowerCase() ?? null)
      : row.channel === 'IMESSAGE'
        ? ''
        : null;
  const grants = access.grants.filter(
    (grant) =>
      grant.ownerUserId === row.userId &&
      grantAccountId(grant) === account &&
      (grant.provider === 'gmail' ? row.channel === 'EMAIL' : row.channel === 'IMESSAGE')
  );
  return {
    owner_user_id: row.userId,
    account_id: account,
    provider: row.channel === 'EMAIL' ? 'gmail' : row.channel.toLowerCase(),
    shared: row.userId !== access.userId || !includesOwnData(access.userId, access.search),
    team_ids: [...new Set(grants.map((grant) => grant.teamId))],
    owner_name: grants[0]?.ownerName ?? null,
  };
}
