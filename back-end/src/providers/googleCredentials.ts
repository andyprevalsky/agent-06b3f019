import { decryptPlaidAccessTokenOrThrow, encryptPlaidAccessToken } from './plaidCredentials';

const GOOGLE_TOKEN_PREFIX = 'google:v1:';

export function isGoogleTokenEncrypted(value: string): boolean {
  return value.startsWith(GOOGLE_TOKEN_PREFIX);
}

/** Uses the same AES-256-GCM and RSA-OAEP-SHA256 envelope as Plaid credentials. */
export function encryptGoogleToken(value: string): string {
  if (isGoogleTokenEncrypted(value)) return value;
  return GOOGLE_TOKEN_PREFIX + encryptPlaidAccessToken(value);
}

/** Plaintext reads are temporary compatibility for rows awaiting the data backfill. */
export function readGoogleToken(value: string): string {
  if (!isGoogleTokenEncrypted(value)) return value;
  return decryptPlaidAccessTokenOrThrow(value.slice(GOOGLE_TOKEN_PREFIX.length));
}
