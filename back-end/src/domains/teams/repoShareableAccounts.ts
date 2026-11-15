/**
 * Per-provider shareable accounts and grant validation (docs/plans/completed/share-all-integrations.md).
 * Every account is exact: an inbox, the single legacy row, a pinned meeting-notes account, one Plaid
 * institution login, one repo, one compute account, one CLI connection or one MCP server. Nothing fans
 * out silently.
 */
import { prisma } from '../../providers/database';
import { MEETING_NOTE_PROVIDERS, SINGLE_ACCOUNT_PROVIDERS } from '../../providers/teamAccess';
import { SHAREABLE_PROVIDERS } from './config';
import type { Prisma, ShareableAccount } from './types';

type Client = Prisma.TransactionClient;
const single = new Set<string>(SINGLE_ACCOUNT_PROVIDERS);
const meeting = new Set<string>(MEETING_NOTE_PROVIDERS);
/** Providers whose Integration row is one account, named by its non-empty accountId. */
const BY_ACCOUNT_ID = new Set(['github_repo', 'claude_code', 'gpt_code', 'cli', 'mcp']);

interface IntegrationFields {
  id: string;
  userId: string;
  name: string;
  accountId: string;
  accountEmail: string | null;
  config: Prisma.JsonValue;
  emailCredentials: Array<{ id: string; userId: string; provider: string; email: string | null }>;
}

const trimmed = (value: string | null | undefined): string | null => {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
};
/** Lowercased, trimmed email, or null when absent or blank. */
const normalizedEmail = (value: string | null | undefined): string | null =>
  trimmed(value)?.toLowerCase() ?? null;

/** Human label for an account row: CLI or MCP server name, repo ref, else the provider account email. */
export function integrationLabel(
  row: Pick<IntegrationFields, 'name' | 'accountId' | 'accountEmail' | 'config'>
): string | null {
  if (row.name === 'cli' || row.name === 'mcp') {
    const config = row.config as { name?: unknown } | null;
    return typeof config?.name === 'string' ? trimmed(config.name) : null;
  }
  if (row.name === 'github_repo') return row.accountId;
  return trimmed(row.accountEmail);
}

/** Rows per (owner, single-account provider), any status: a second row makes the account ambiguous. */
export async function singleAccountCounts(ownerIds: string[], client: Client = prisma) {
  if (ownerIds.length === 0) return new Map<string, number>();
  const rows = await client.integration.groupBy({
    by: ['userId', 'name'],
    where: { userId: { in: ownerIds }, name: { in: [...SINGLE_ACCOUNT_PROVIDERS] } },
    _count: true,
  });
  return new Map(rows.map((row) => [`${row.userId}:${row.name}`, row._count]));
}

function gmailAccounts(
  integration: IntegrationFields
): Array<Pick<ShareableAccount, 'id' | 'accountId' | 'accountEmail' | 'label'>> {
  return integration.emailCredentials.flatMap((credential) => {
    const email = normalizedEmail(credential.email);
    if (
      email === null ||
      credential.userId !== integration.userId ||
      credential.provider.toLowerCase() !== integration.name
    )
      return [];
    return [{ id: credential.id, accountId: email, accountEmail: email, label: email }];
  });
}

/** The user's connected accounts that can be shared, one entry per exact account. */
export async function shareableAccounts(
  userId: string,
  client: Client = prisma
): Promise<ShareableAccount[]> {
  const integrations = await client.integration.findMany({
    where: { userId, name: { in: [...SHAREABLE_PROVIDERS] }, status: 'CONNECTED', isActive: true },
    include: { emailCredentials: { where: { state: 'connected' } } },
    orderBy: { createdAt: 'asc' },
  });
  const counts = await singleAccountCounts([userId], client);
  const plaid = integrations.find((row) => row.name === 'plaid');
  const items = plaid
    ? await client.plaidItem.findMany({
        where: { userId, integrationId: plaid.id, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, institutionName: true },
      })
    : [];
  const result: ShareableAccount[] = [];
  for (const integration of integrations) {
    const base = {
      integrationId: integration.id,
      provider: integration.name,
      name: integration.name,
      status: integration.status,
      ownerUserId: userId,
    };
    const push = (account: Pick<ShareableAccount, 'id' | 'accountId' | 'accountEmail' | 'label'>) =>
      result.push({ ...base, ...account });
    if (single.has(integration.name)) {
      if (integration.accountId === '' && counts.get(`${userId}:${integration.name}`) === 1)
        push({ id: integration.id, accountId: '', accountEmail: null, label: null });
    } else if (meeting.has(integration.name)) {
      if (integration.accountId === '')
        push({
          id: integration.id,
          accountId: '',
          accountEmail: normalizedEmail(integration.accountEmail),
          label: trimmed(integration.accountEmail),
        });
    } else if (integration.name === 'plaid') {
      for (const item of items)
        push({
          id: item.id,
          accountId: item.id,
          accountEmail: null,
          label: trimmed(item.institutionName),
        });
    } else if (BY_ACCOUNT_ID.has(integration.name)) {
      if (integration.accountId !== '')
        push({
          id: integration.id,
          accountId: integration.accountId,
          accountEmail: null,
          label: integrationLabel(integration),
        });
    } else if (integration.name === 'gmail') {
      for (const account of gmailAccounts(integration)) push(account);
    }
  }
  return result;
}

export interface ShareRow {
  ownerUserId: string;
  provider: string;
  accountId: string;
  accountEmail: string | null;
  integration: IntegrationFields;
}
export interface GrantContext {
  counts: Map<string, number>;
  items: Map<string, { userId: string; integrationId: string; institutionName: string | null }>;
}

/** Everything grant validation needs beyond the share rows, in two indexed queries at most. */
export async function grantContext(
  rows: ShareRow[],
  client: Client = prisma
): Promise<GrantContext> {
  const owners = [
    ...new Set(rows.filter((row) => single.has(row.provider)).map((row) => row.ownerUserId)),
  ];
  const itemIds = [
    ...new Set(rows.filter((row) => row.provider === 'plaid').map((row) => row.accountId)),
  ];
  const [counts, items] = await Promise.all([
    singleAccountCounts(owners, client),
    itemIds.length
      ? client.plaidItem.findMany({
          where: { id: { in: itemIds }, status: 'ACTIVE' },
          select: { id: true, userId: true, integrationId: true, institutionName: true },
        })
      : Promise.resolve([]),
  ]);
  return { counts, items: new Map(items.map((item) => [item.id, item])) };
}

/** The grant's current label when the shared account still exists exactly as shared; else null. */
export function validateGrant(
  row: ShareRow,
  context: GrantContext
): { label: string | null } | null {
  const integration = row.integration;
  if (integration.userId !== row.ownerUserId || integration.name !== row.provider) return null;
  if (single.has(row.provider)) {
    const unique = context.counts.get(`${row.ownerUserId}:${row.provider}`) === 1;
    return row.accountId === '' &&
      integration.accountId === '' &&
      row.accountEmail === null &&
      unique
      ? { label: null }
      : null;
  }
  if (meeting.has(row.provider)) {
    // Pinned: signing in to a different meeting-notes account under the same row ends the share.
    const email = normalizedEmail(integration.accountEmail);
    return row.accountId === '' &&
      integration.accountId === '' &&
      (row.accountEmail ?? null) === email
      ? { label: trimmed(integration.accountEmail) }
      : null;
  }
  if (row.provider === 'plaid') {
    const item = context.items.get(row.accountId);
    return item && item.userId === row.ownerUserId && item.integrationId === integration.id
      ? { label: trimmed(item.institutionName) }
      : null;
  }
  if (BY_ACCOUNT_ID.has(row.provider)) {
    return row.accountId !== '' && integration.accountId === row.accountId
      ? { label: integrationLabel(integration) }
      : null;
  }
  if (row.provider === 'gmail') {
    const healthy = integration.emailCredentials.some(
      (credential) =>
        credential.userId === row.ownerUserId &&
        credential.provider.toLowerCase() === row.provider &&
        credential.email?.trim().toLowerCase() === row.accountEmail
    );
    return row.accountEmail !== null &&
      row.accountEmail !== '' &&
      row.accountId === row.accountEmail &&
      healthy
      ? { label: row.accountEmail }
      : null;
  }
  return null;
}
