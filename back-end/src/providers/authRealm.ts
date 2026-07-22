/**
 * Auth realm canonicalization shared by browser credential flows.
 */

import { getDomain } from 'tldts';

export function hostnameFromRealmInput(input: string): string {
  const raw = input.trim().toLowerCase();
  if (raw === '') return '';
  const explicitScheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  const looksLikeHostPort = /^[^/?#]+:\d+(?:[/?#]|$)/.test(raw);
  if (
    explicitScheme !== undefined &&
    explicitScheme !== 'http' &&
    explicitScheme !== 'https' &&
    !looksLikeHostPort
  ) {
    return '';
  }
  try {
    const url = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
    return new URL(url).hostname.replace(/^\.+/, '').replace(/^www\./, '');
  } catch {
    return (
      raw
        .replace(/^\.+/, '')
        .replace(/^www\./, '')
        .split('/')[0] ?? raw
    );
  }
}

export function canonicalAuthRealm(input: string): string {
  const raw = input.trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const url = new URL(raw);
      const hostname = url.hostname.toLowerCase();
      const allowQueryOverride =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        ['.ngrok-free.dev', '.ngrok.app', '.ngrok.io', '.loca.lt'].some((suffix) =>
          hostname.endsWith(suffix)
        );
      const override =
        url.searchParams.get('authRealm') ?? url.searchParams.get('auth_realm') ?? '';
      if (allowQueryOverride && override !== '') {
        const overrideRealm = canonicalAuthRealm(override);
        if (overrideRealm !== '') return overrideRealm;
      }
    } catch {
      // Fall through to the normal hostname parser below.
    }
  }
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

  // Public-Suffix-List-aware eTLD+1 resolution handles both ordinary
  // subdomains (identity.doordash.com) and multi-label public suffixes
  // (shop.example.co.uk -> example.co.uk) without broadening to co.uk.
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

export function domainMatchesAuthRealm(domain: string, authRealm: string): boolean {
  const normalizedDomain = hostnameFromRealmInput(domain);
  const normalizedRealm = canonicalAuthRealm(authRealm);
  return normalizedDomain === normalizedRealm || normalizedDomain.endsWith(`.${normalizedRealm}`);
}

export function authRealmFromCookieDomain(domain: string): string {
  return canonicalAuthRealm(domain);
}
