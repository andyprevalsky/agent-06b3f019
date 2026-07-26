import { benchmarkSavedBrowserAuthDisabled } from '../../providers/benchmarkBrowserAuth';
import { canonicalAuthRealm } from '../../providers/authRealm';
import * as repo from './repo';

export async function findRequiredSteelProfileForStart(
  userId: string,
  startUrl: string
): Promise<string | null> {
  const authRealm = canonicalAuthRealm(startUrl);
  if (authRealm === '' || benchmarkSavedBrowserAuthDisabled()) return null;
  const auth = await repo.findEnabledSteelSessionAuth(userId, authRealm);
  return auth?.contextId ?? null;
}
