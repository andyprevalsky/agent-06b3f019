/**
 * Auth realm canonicalization shared by browser credential flows.
 */

export function hostnameFromRealmInput(input: string): string {
  const raw = input.trim().toLowerCase();
  if (raw === '') return '';
  try {
    const url = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
    return new URL(url).hostname.replace(/^\.+/, '');
  } catch {
    return raw.replace(/^\.+/, '').split('/')[0] ?? raw;
  }
}

export function canonicalAuthRealm(input: string): string {
  const hostname = hostnameFromRealmInput(input);
  if (hostname === '') return '';
  if (hostname === 'aws.amazon.com' || hostname.endsWith('.aws.amazon.com')) {
    return 'aws.amazon.com';
  }
  if (hostname === 'amazon.com' || hostname.endsWith('.amazon.com')) {
    return 'amazon.com';
  }
  if (hostname === 'uber.com' || hostname.endsWith('.uber.com')) {
    return 'uber.com';
  }

  return hostname;
}

export function domainMatchesAuthRealm(domain: string, authRealm: string): boolean {
  const normalizedDomain = hostnameFromRealmInput(domain);
  const normalizedRealm = canonicalAuthRealm(authRealm);
  return normalizedDomain === normalizedRealm || normalizedDomain.endsWith(`.${normalizedRealm}`);
}

export function authRealmFromCookieDomain(domain: string): string {
  return canonicalAuthRealm(domain);
}
