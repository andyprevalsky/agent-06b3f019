/** Reuse the browser shared-store resolver without minted identity side effects. */
import type { Prisma } from '@prisma/client';
import { decryptCredentialEnvelope } from './claudeCredentials';
import { resolvePasswordOptions } from './authOptions';
import { hostnameFromRealmInput } from './authRealm';
const APPLE_HOSTS = new Set([
  'apple.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'account.apple.com',
]);
const GOOGLE_HOSTS = new Set(['accounts.google.com', 'google.com']);

/**
 * Every enabled Google password saved for exactly this account, newest-used
 * first, decrypted and de-duplicated. Used to try each one in turn when a human
 * reaches Google's password challenge (connect + auth assistance). Ordering is
 * by Chromium's `dateLastUsed` (a password the user actually signs in with wins
 * over a stale one), then `dateCreated`, both descending; nulls sort last.
 */
export async function googlePasswordCandidates(
  tx: Prisma.TransactionClient,
  userId: string,
  identity: string
): Promise<string[]> {
  const origins = [...GOOGLE_HOSTS].flatMap((host) =>
    ['https://', 'http://', ''].flatMap((scheme) => [
      { origin: { equals: `${scheme}${host}`, mode: 'insensitive' as const } },
      { origin: { startsWith: `${scheme}${host}/`, mode: 'insensitive' as const } },
    ])
  );
  const rows = await tx.browserPassword.findMany({
    where: {
      userId,
      username: { equals: identity, mode: 'insensitive' },
      disabledAt: null,
      OR: origins,
    },
    // Order before the limit so >32 rows can't drop the newest-used password.
    orderBy: [
      { dateLastUsed: { sort: 'desc', nulls: 'last' } },
      { dateCreated: { sort: 'desc', nulls: 'last' } },
    ],
    take: 32,
  });
  const key = process.env.PAYMENT_DECRYPTION_KEY;
  if (key === undefined || key === '') return [];
  const rank = (value: bigint | null): bigint => value ?? -1n;
  const ordered = rows
    .filter((r) => GOOGLE_HOSTS.has(hostnameFromRealmInput(r.origin)))
    .sort((a, b) => {
      const byUsed = rank(b.dateLastUsed) - rank(a.dateLastUsed);
      if (byUsed !== 0n) return byUsed > 0n ? 1 : -1;
      const byCreated = rank(b.dateCreated) - rank(a.dateCreated);
      return byCreated > 0n ? 1 : byCreated < 0n ? -1 : 0;
    });
  const seen = new Set<string>();
  const values: string[] = [];
  for (const row of ordered) {
    const value = decryptCredentialEnvelope(row.encryptedPassword, key);
    if (value !== null && value !== '' && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

export async function selectedPassword(
  tx: Prisma.TransactionClient,
  userId: string,
  identity: string,
  realm: 'apple' | 'google' = 'apple'
) {
  const hosts = realm === 'apple' ? APPLE_HOSTS : new Set(['accounts.google.com', 'google.com']);
  const origins = [...hosts].flatMap((host) =>
    ['https://', 'http://', ''].flatMap((scheme) => [
      { origin: { equals: `${scheme}${host}`, mode: 'insensitive' as const } },
      { origin: { startsWith: `${scheme}${host}/`, mode: 'insensitive' as const } },
    ])
  );
  const rows = await tx.browserPassword.findMany({
    where: {
      userId,
      username: { equals: identity, mode: 'insensitive' },
      disabledAt: null,
      OR: origins,
    },
    take: 33,
  });
  if (rows.length > 32) throw new Error('phone_credential_unavailable');
  const apple = rows.filter((r) => hosts.has(hostnameFromRealmInput(r.origin)));
  const options = resolvePasswordOptions(
    realm === 'apple' ? 'apple.com' : 'google.com',
    apple,
    false
  ).filter((r) => !r.disabled);
  // BrowserPassword envelopes share the browser/payment key domain, not backend phone/Plaid.
  const key = process.env.PAYMENT_DECRYPTION_KEY;
  if (key === undefined || key === '' || !options.length)
    throw new Error('phone_credential_unavailable');
  const values = options.map((option) =>
    decryptCredentialEnvelope(apple.find((r) => r.id === option.id)!.encryptedPassword, key)
  );
  if (values.some((v) => v === null || v === '') || new Set(values).size !== 1)
    throw new Error('phone_credential_unavailable');
  return values[0]!;
}
