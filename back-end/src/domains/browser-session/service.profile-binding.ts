import { benchmarkSavedBrowserAuthDisabled } from '../../providers/benchmarkBrowserAuth';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { selectedBrowserProvider } from '../../providers/browser/config';
import { shareSteelProfileSignIn } from '../../providers/browser/steelProfileAuthMigration';
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

/**
 * The Steel profile a new session must load, or null. Only a Steel-selected
 * deployment keeps loading the bound profile; every other provider receives the
 * sign-in through the provider-neutral stores (migrated once, typed failure).
 */
export async function steelProfileForSelectedProvider(
  userId: string,
  startUrl: string,
  steelBoundProfileId: string | null,
  share: typeof shareSteelProfileSignIn = shareSteelProfileSignIn
): Promise<string | null> {
  if (steelBoundProfileId === null) return null;
  const provider = selectedBrowserProvider();
  if (provider === 'steel') return steelBoundProfileId;
  await share(userId, startUrl, provider);
  return null;
}
