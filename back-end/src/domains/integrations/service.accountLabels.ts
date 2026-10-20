/**
 * Server-side label for an Integration row that carries no account email, so
 * every client shows the same text for the row's single account. Pure.
 *
 *   gmail (connected a@x.com, b@y.com) → "a@x.com, b@y.com"
 *   chrome_passwords                   → "Chrome"
 *   apple_passwords                    → "Apple Passwords"
 *   anything else                      → null (the UI names the provider)
 */

const SOURCE_NAMES: Record<string, string> = {
  apple: 'Apple Passwords',
  arc: 'Arc',
  atlas: 'Atlas',
  brave: 'Brave',
  chrome: 'Chrome',
  chromium: 'Chromium',
  edge: 'Edge',
  opera: 'Opera',
  safari: 'Safari',
  vivaldi: 'Vivaldi',
};

/** A display label for a row whose `accountEmail` is empty; null when nothing fits. */
export function derivedRowLabel(provider: string, connectedEmails: string[]): string | null {
  if (connectedEmails.length > 0) return connectedEmails.join(', ');
  const credential = /^(.+)_(passwords|passkeys)$/.exec(provider);
  if (credential === null) return null;
  const source = credential[1] ?? '';
  return SOURCE_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}
