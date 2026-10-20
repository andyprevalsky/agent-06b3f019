/**
 * Server-side account labels for providers whose rows carry no human name
 * (per-source password/passkey accounts, LinkedIn profiles), so every client
 * shows the same text. Pure; the stored account id is the only input.
 *
 *   chrome_passwords + "chrome:Profile 1"  → "Chrome · Profile 1"
 *   chrome_passwords + "chrome:Default"    → "Chrome"
 *   apple_passwords  + ""                  → "Apple Passwords"
 *   linkedin + "ada-owner-3003"            → "linkedin.com/in/ada-owner-3003"
 *   linkedin + "urn:li:member:4004"        → "LinkedIn member 4004"
 */

const SOURCE_NAMES: Record<string, string> = {
  apple: 'Apple Passwords',
  arc: 'Arc',
  atlas: 'Atlas',
  brave: 'Brave',
  cdp_virtual: 'Rose agent',
  chrome: 'Chrome',
  chromium: 'Chromium',
  edge: 'Edge',
  opera: 'Opera',
  safari: 'Safari',
  vivaldi: 'Vivaldi',
};

function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

function credentialLabel(provider: string, storageAccountId: string): string | null {
  const match = /^(.+)_(passwords|passkeys)$/.exec(provider);
  if (!match) return null;
  const [source, profile] = storageAccountId.includes(':')
    ? [
        storageAccountId.slice(0, storageAccountId.indexOf(':')),
        storageAccountId.slice(storageAccountId.indexOf(':') + 1),
      ]
    : [match[1] ?? provider, ''];
  const name = sourceName(source ?? '');
  return profile === '' || profile === 'Default' ? name : `${name} · ${profile}`;
}

function linkedinLabel(storageAccountId: string): string | null {
  if (storageAccountId === '') return null;
  const member = /^urn:li:member:(\d+)$/.exec(storageAccountId);
  if (member) return `LinkedIn member ${member[1]}`;
  return `linkedin.com/in/${storageAccountId}`;
}

/** A display label for an account whose row has none; null when nothing fits. */
export function derivedAccountLabel(provider: string, storageAccountId: string): string | null {
  if (provider === 'linkedin') return linkedinLabel(storageAccountId);
  return credentialLabel(provider, storageAccountId);
}
