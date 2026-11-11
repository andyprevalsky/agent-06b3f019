/** Explicit search scope. Selectors narrow authority; they never grant it. */
import { InvalidGrepParamError } from './errors';
import type { TeamSearchScope } from './types.team';
export type { TeamSearchScope } from './types.team';

export function parseTeamSearchScope(params: {
  scope?: unknown;
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
  const scope = params.scope ?? 'all';
  if (scope !== 'own' && scope !== 'shared' && scope !== 'all') {
    throw new InvalidGrepParamError('scope', 'Use own, shared, or all.');
  }
  return { scope, teamId, ownerUserId, accountId };
}

export function includesOwnData(userId: string, scope: TeamSearchScope): boolean {
  return (
    scope.scope !== 'shared' &&
    scope.teamId === undefined &&
    (scope.ownerUserId === undefined || scope.ownerUserId === userId)
  );
}

export function includesPrivateSources(userId: string, scope: TeamSearchScope): boolean {
  return includesOwnData(userId, scope) && scope.accountId === undefined;
}
