/** SQL authority for shared communications, applied before matching and LIMIT. */
import { Prisma } from '@prisma/client';
import {
  agentAccountId,
  resolveTeamDataAccess,
  SINGLE_ACCOUNT_PROVIDERS,
  type TeamDataGrant,
} from '../../providers/teamAccess';
import type { GrepOwnership } from './types.message';
import {
  accountChannel,
  channelAccountId,
  includesOwnData,
  type TeamSearchScope,
} from './teamAccess';

export type SharedGrant = TeamDataGrant;
export interface MessageAccess {
  userId: string;
  search: TeamSearchScope;
  grants: SharedGrant[];
}

/** Message channel of each provider whose shared account is a message corpus. */
const MESSAGE_CHANNELS = new Map([
  ['gmail', 'EMAIL'],
  ['imessage', 'IMESSAGE'],
  ['whatsapp', 'WHATSAPP'],
  ['linkedin', 'LINKEDIN'],
]);
const SINGLE = new Set<string>(SINGLE_ACCOUNT_PROVIDERS);

/** Every grant a request scope may read; one resolver query per grep request. */
export async function resolveScopeGrants(
  userId: string,
  search: TeamSearchScope
): Promise<SharedGrant[]> {
  return search.ownerUserId === userId && search.teamId === undefined
    ? []
    : resolveTeamDataAccess(userId, { teamId: search.teamId, ownerUserId: search.ownerUserId });
}

function isMessageGrant(grant: SharedGrant): boolean {
  if (grant.provider === 'gmail') return Boolean(grant.accountEmail?.trim());
  return SINGLE.has(grant.provider) && grant.accountId === '';
}

export async function resolveMessageAccess(
  userId: string,
  search: TeamSearchScope,
  grants?: SharedGrant[]
): Promise<MessageAccess> {
  const resolved = grants ?? (await resolveScopeGrants(userId, search));
  return { userId, search, grants: resolved.filter(isMessageGrant) };
}

/**
 * The share still authorizes `readerId` at this read: both members accepted, the integration
 * connected, active and owned by the grant owner, and `account` (provider-specific SQL over
 * `s`/`i`) still names the exact shared account. A revocation between resolver and query
 * cannot retain authority via a cached grant.
 */
export function liveShareExists(
  readerId: string,
  grant: SharedGrant,
  account: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "TeamIntegrationShare" s
    JOIN "Integration" i ON i.id = s."integrationId"
    JOIN "TeamMember" reader ON reader."teamId" = s."teamId"
    JOIN "TeamMember" owner ON owner."teamId" = s."teamId" AND owner."userId" = i."userId"
    WHERE s."teamId" = ${grant.teamId} AND s."integrationId" = ${grant.integrationId}
      AND reader."userId" = ${readerId} AND reader.status = 'ACCEPTED'
      AND owner.status = 'ACCEPTED' AND i.status::text = 'CONNECTED'
      AND i."isActive" = true AND i.type::text = 'DATA_SOURCE'
      AND s."ownerUserId" = i."userId" AND s.provider = i.name
      AND i."userId" = ${grant.ownerUserId} AND i.name = ${grant.provider}
      AND s."accountId" = ${grant.accountId}
      AND ${account}
  )`;
}

/** The owner's one row for a single-account provider, still unambiguous. */
export const SINGLE_ROW_ACCOUNT = Prisma.sql`i."accountId" = '' AND NOT EXISTS (
  SELECT 1 FROM "Integration" other WHERE other."userId" = i."userId"
    AND other.name = i.name AND other.id <> i.id
)`;

function messageAccountSql(grant: SharedGrant, account: string): Prisma.Sql {
  return grant.provider === 'gmail'
    ? Prisma.sql`lower(s."accountEmail") = ${account} AND EXISTS (
        SELECT 1 FROM "EmailIntegrationCredential" ec WHERE ec."integrationId" = i.id
          AND ec."userId" = i."userId" AND lower(ec.email) = ${account}
          AND ec.state = 'connected' AND lower(ec.provider::text) = i.name
      )`
    : SINGLE_ROW_ACCOUNT;
}

export function messageAccessPredicate(access: MessageAccess, alias = 'm'): Prisma.Sql {
  // Alias is chosen by this module's callers, never from a request.
  if (!['m', 'a'].includes(alias)) throw new Error('Invalid message SQL alias');
  const col = (name: string) => Prisma.raw(`${alias}."${name}"`);
  const channelIs = (channel: string) => Prisma.sql`${col('channel')}::text = ${channel}`;
  const inbox = (email: string) =>
    Prisma.sql`${channelIs('EMAIL')} AND lower(${col('googleAccountEmail')}) = ${email}`;
  const requested = access.search.accountId?.toLowerCase();
  const parts: Prisma.Sql[] = [];
  if (includesOwnData(access.userId, access.search)) {
    const channel = requested === undefined ? undefined : accountChannel(requested);
    const accountFilter =
      requested === undefined
        ? Prisma.empty
        : channel !== undefined
          ? Prisma.sql`AND ${channelIs(channel)}`
          : Prisma.sql`AND ${inbox(requested)}`;
    parts.push(Prisma.sql`(${col('userId')} = ${access.userId} ${accountFilter})`);
  }
  for (const grant of access.grants) {
    const account = agentAccountId(grant);
    const channel = MESSAGE_CHANNELS.get(grant.provider);
    if (channel === undefined || (requested !== undefined && requested !== account)) continue;
    const provenance = grant.provider === 'gmail' ? inbox(account) : channelIs(channel);
    parts.push(Prisma.sql`(${col('userId')} = ${grant.ownerUserId} AND ${provenance}
      AND ${liveShareExists(access.userId, grant, messageAccountSql(grant, account))})`);
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : Prisma.sql`FALSE`;
}

/** Owner, exact agent-facing account and the teams that share it, for one returned row. */
export function rowOwnership(
  access: MessageAccess,
  row: { ownerUserId: string; provider: string; accountId: string | null }
): GrepOwnership {
  const grants = access.grants.filter(
    (grant) =>
      grant.ownerUserId === row.ownerUserId &&
      grant.provider === row.provider &&
      agentAccountId(grant) === row.accountId
  );
  return {
    owner_user_id: row.ownerUserId,
    account_id: row.accountId,
    provider: row.provider,
    shared: row.ownerUserId !== access.userId || !includesOwnData(access.userId, access.search),
    team_ids: [...new Set(grants.map((grant) => grant.teamId))],
    owner_name: grants[0]?.ownerName ?? null,
  };
}

export function messageOwnership(
  access: MessageAccess,
  row: { userId: string; channel: string; googleAccountEmail: string | null }
): GrepOwnership {
  return rowOwnership(access, {
    ownerUserId: row.userId,
    provider: row.channel === 'EMAIL' ? 'gmail' : row.channel.toLowerCase(),
    accountId: channelAccountId(row.channel, row.googleAccountEmail),
  });
}
