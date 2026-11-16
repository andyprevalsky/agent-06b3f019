/** Search narrowing. Selectors narrow authority; they never grant it. */
import { InvalidGrepParamError } from './errors';
import type { TeamSearchScope } from './types.team';
export type { TeamSearchScope } from './types.team';

export function parseTeamSearchScope(params: {
  team_id?: unknown;
  owner_user_id?: unknown;
  account_id?: unknown;
}): TeamSearchScope {
  const value = (key: 'team_id' | 'owner_user_id' | 'account_id'): string | undefined => {
    const raw = params[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string' || (key !== 'account_id' && raw.trim() === '')) {
      throw new InvalidGrepParamError(key, 'Expected an exact identifier.');
    }
    return raw.trim();
  };
  const teamId = value('team_id');
  const ownerUserId = value('owner_user_id');
  const accountId = value('account_id');
  return { teamId, ownerUserId, accountId };
}

export function includesOwnData(userId: string, scope: TeamSearchScope): boolean {
  return (
    scope.teamId === undefined && (scope.ownerUserId === undefined || scope.ownerUserId === userId)
  );
}

export function includesPrivateSources(userId: string, scope: TeamSearchScope): boolean {
  return includesOwnData(userId, scope) && scope.accountId === undefined;
}

/** Agent-facing account id of a message row's channel: inbox email, '' (iMessage) or the provider. */
const CHANNEL_ACCOUNT = new Map([
  ['IMESSAGE', ''],
  ['WHATSAPP', 'whatsapp'],
  ['LINKEDIN', 'linkedin'],
]);
export function channelAccountId(
  channel: string,
  googleAccountEmail: string | null
): string | null {
  if (channel === 'EMAIL') return googleAccountEmail?.toLowerCase() ?? null;
  return CHANNEL_ACCOUNT.get(channel) ?? null;
}
/** The message channel an agent-facing account id selects, or undefined for a Gmail inbox. */
export function accountChannel(accountId: string): string | undefined {
  return [...CHANNEL_ACCOUNT].find(([, account]) => account === accountId)?.[0];
}
