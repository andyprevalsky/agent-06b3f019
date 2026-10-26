import { createHmac } from './crypto';
import { encryptPlaidAccessToken, decryptPlaidAccessTokenOrThrow } from './plaidCredentials';

/** Use the existing server-derived RSA/AES credential envelope, without plaintext storage. */
export function sealPhoneValue(value: unknown): string {
  return encryptPlaidAccessToken(JSON.stringify(value));
}

export function openPhoneValue<T>(encrypted: string): T {
  return JSON.parse(decryptPlaidAccessTokenOrThrow(encrypted)) as T;
}

export function phoneCommandHash(operation: string, args: unknown, actor: string): string {
  const key = process.env.BACKEND_API_KEY;
  if (key === undefined || key === '') throw new Error('Phone command authentication unavailable');
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => [name, stable(entry)])
    );
  };
  return createHmac('sha256', key)
    .update(JSON.stringify(stable([operation, args, actor])))
    .digest('hex');
}
