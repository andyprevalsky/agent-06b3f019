/**
 * Passwords and passkeys as integration accounts (plan row I7).
 *
 *   browserSource ──passwordIntegrationName──► provider `<source>_passwords`
 *                                               (Apple import: `apple_passwords`)
 *   browserProfile ──cookieAccountStorageId──► accountId `<source>:<profile>`
 *                                               (`''` / wire `default` = no profile),
 *                                               the same spelling as cookie accounts
 *
 *   browserSource ──passkeyIntegrationName───► provider `<source>_passkeys`,
 *                                               one `default` account per source
 *
 * The delete hooks remove exactly one source+profile's rows (plus its
 * Integration row); `false` means the account had nothing to remove.
 */

import * as repo from './repo.credentialAccounts';
import { cookieProfileFromAccountId } from './syncAccountsContract';

const PASSWORDS_SUFFIX = '_passwords';
const PASSKEYS_SUFFIX = '_passkeys';
const APPLE_PASSWORDS = 'apple_passwords';

interface CredentialAccountKey {
  userId: string;
  provider: string;
  /** Storage account id: `<source>:<profile>`, `''` for none. */
  accountId: string;
}

export function passwordIntegrationName(browserSource: string): string {
  if (browserSource === APPLE_PASSWORDS) return APPLE_PASSWORDS;
  return `${browserSource}${PASSWORDS_SUFFIX}`;
}

/** Every browserSource whose passwords land under `provider` (inverse of the name). */
export function passwordSourcesForProvider(provider: string): string[] {
  if (!provider.endsWith(PASSWORDS_SUFFIX)) return [];
  const stem = provider.slice(0, -PASSWORDS_SUFFIX.length);
  if (stem === '') return [];
  // `apple_passwords` is both the Apple import's own source and `apple` + suffix.
  return provider === APPLE_PASSWORDS ? [APPLE_PASSWORDS, stem] : [stem];
}

export function passkeyIntegrationName(browserSource: string): string {
  return `${browserSource}${PASSKEYS_SUFFIX}`;
}

export function passkeySourceForProvider(provider: string): string | null {
  if (!provider.endsWith(PASSKEYS_SUFFIX)) return null;
  const source = provider.slice(0, -PASSKEYS_SUFFIX.length);
  return source === '' ? null : source;
}

/** The profile an account id names (`chrome:Profile 1` → `Profile 1`). */
function passwordProfileFromAccountId(browserSources: string[], accountId: string): string {
  for (const source of browserSources) {
    if (accountId.startsWith(`${source}:`)) return cookieProfileFromAccountId(source, accountId);
  }
  return accountId;
}

/** Account = one browser profile of one source: its saved logins and its row. */
export async function deletePasswordAccount(key: CredentialAccountKey): Promise<boolean> {
  const browserSources = passwordSourcesForProvider(key.provider);
  if (browserSources.length === 0) return false;
  const removed = await repo.deletePasswordAccountRows({
    userId: key.userId,
    provider: key.provider,
    accountId: key.accountId,
    browserSources,
    browserProfile: passwordProfileFromAccountId(browserSources, key.accountId),
  });
  return removed.credentials > 0 || removed.integrationRows > 0;
}

/** Passkeys carry no profile: a source has only its `default` account. */
export async function deletePasskeyAccount(key: CredentialAccountKey): Promise<boolean> {
  const browserSource = passkeySourceForProvider(key.provider);
  if (browserSource === null || key.accountId !== '') return false;
  const removed = await repo.deletePasskeyAccountRows({
    userId: key.userId,
    provider: key.provider,
    browserSource,
  });
  return removed.credentials > 0 || removed.integrationRows > 0;
}
