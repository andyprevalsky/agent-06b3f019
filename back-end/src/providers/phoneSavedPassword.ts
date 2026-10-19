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
export async function selectedPassword(
  tx: Prisma.TransactionClient,
  userId: string,
  identity: string
) {
  const origins = [...APPLE_HOSTS].flatMap((host) =>
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
  const apple = rows.filter((r) => APPLE_HOSTS.has(hostnameFromRealmInput(r.origin)));
  const options = resolvePasswordOptions('apple.com', apple, false).filter((r) => !r.disabled);
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
