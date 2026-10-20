/**
 * Readable chip labels for password and passkey accounts (plan row I7).
 *
 * Pure functions, no state machine. Backend contract
 * (back-end/src/domains/integrations/service.credentialAccounts.ts):
 *
 *   provider `<source>_passwords` (Apple import: `apple_passwords`)
 *     accountId `<source>:<profile>`, `default` = no profile (legacy row)
 *       chrome_passwords / chrome:Profile 1  → "Chrome · Profile 1"
 *       chrome_passwords / default           → "Chrome · Default profile"
 *       apple_passwords  / default           → "Apple Passwords" (no profiles)
 *   provider `<source>_passkeys`, one `default` account per source
 *       cdp_virtual_passkeys      → "Agent passkeys" (agents enrolled them; Rose
 *                                   holds the only copy, so removal warns)
 *       apple_passwords_passkeys  → "Apple passkeys"
 */

import type { ConnectedIntegration, IntegrationAccount } from '../types';

const PASSWORDS_SUFFIX = '_passwords';
const PASSKEYS_SUFFIX = '_passkeys';

/** Where agents enroll passkeys (mac-app passkey-enroll PASSKEY_BROWSER_SOURCE). */
export const AGENT_PASSKEYS_PROVIDER = 'cdp_virtual_passkeys';

export const AGENT_PASSKEYS_REMOVAL_WARNING =
  'This is the only copy of the passkeys your agents enrolled. Removing it deletes them ' +
  'permanently: they cannot be synced back, and your agents will need to enroll new passkeys ' +
  'to sign in to those sites again.';

/** Password providers that already have a fixed row in the Passwords section. */
export const FIXED_PASSWORD_PROVIDERS: readonly string[] = [
  'chrome_passwords',
  'apple_passwords',
  'atlas_passwords',
];

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  chrome: 'Chrome',
  atlas: 'ChatGPT Atlas',
  edge: 'Edge',
  brave: 'Brave',
  arc: 'Arc',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  chromium: 'Chromium',
  safari: 'Safari',
  apple: 'Apple',
  apple_passwords: 'Apple',
  cdp_virtual: 'Agent',
};

/** "Chrome" for `chrome`; an unknown source is capitalized as-is. */
export function credentialSourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** `<source>` of a `<source>_passwords` provider, or null for any other provider. */
export function passwordSource(provider: string): string | null {
  if (!provider.endsWith(PASSWORDS_SUFFIX)) return null;
  const source = provider.slice(0, -PASSWORDS_SUFFIX.length);
  return source === '' ? null : source;
}

/** Chip label of one password account (see the table above). */
export function passwordAccountLabel(provider: string, account: IntegrationAccount): string {
  const source = passwordSource(provider) ?? provider;
  if (source === 'apple') return 'Apple Passwords';
  const prefix = `${source}:`;
  let profile = account.accountId.startsWith(prefix)
    ? account.accountId.slice(prefix.length)
    : account.accountId;
  if (!account.unlabeled) profile = account.label;
  const readable = profile === 'default' || profile === '' ? 'Default profile' : profile;
  return `${credentialSourceName(source)} · ${readable}`;
}

/** Chip label of a passkey store: "Agent passkeys", "Apple passkeys", "Chrome passkeys". */
export function passkeyAccountLabel(provider: string): string {
  const source = provider.endsWith(PASSKEYS_SUFFIX)
    ? provider.slice(0, -PASSKEYS_SUFFIX.length)
    : provider;
  return `${credentialSourceName(source)} passkeys`;
}

/** First row of each distinct name matching `keep`, in list order. */
function firstRowPerName(
  integrations: ConnectedIntegration[],
  keep: (name: string) => boolean,
): ConnectedIntegration[] {
  const seen = new Set<string>();
  return integrations.filter((row) => {
    if (!keep(row.name) || seen.has(row.name)) return false;
    seen.add(row.name);
    return true;
  });
}

/**
 * One row per passkey provider. Rows of one provider carry the same account
 * list, so listing a provider twice would duplicate its chips.
 */
export function passkeyProviderRows(integrations: ConnectedIntegration[]): ConnectedIntegration[] {
  return firstRowPerName(integrations, (name) => name.endsWith(PASSKEYS_SUFFIX));
}

/** `<source>_passwords` rows without a fixed Passwords row (e.g. `brave_passwords`). */
export function extraPasswordRows(integrations: ConnectedIntegration[]): ConnectedIntegration[] {
  return firstRowPerName(
    integrations,
    (name) => passwordSource(name) !== null && !FIXED_PASSWORD_PROVIDERS.includes(name),
  );
}
