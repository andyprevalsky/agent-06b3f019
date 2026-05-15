import { randomBytes, createCipheriv, publicEncrypt, constants } from './crypto';
import { createLogger } from './logger';
import { decryptCredentialEnvelope } from './claudeCredentials';
import { RSA_PUBLIC_KEY_PEM } from '../domains/integrations/config';

const log = createLogger('PlaidCredentials');

/**
 * Encrypt a Plaid `access_token` (or any sensitive Plaid credential string)
 * into an AES-256-GCM + RSA-OAEP-SHA256 envelope. Returns a base64-encoded
 * JSON envelope identical in structure to the password / Claude Code envelope.
 *
 * This is the canonical envelope referenced in the Rose Labs Information
 * Security Policy (§7) and the Privacy Policy (§3): Plaid access tokens are
 * encrypted at the application layer prior to storage in our database, in
 * addition to the at-rest encryption provided by Supabase Postgres.
 *
 * Encryption key: `RSA_PUBLIC_KEY_PEM` from `domains/integrations/config.ts`
 * Decryption key: same RSA private key as `CLAUDE_CREDENTIAL_DECRYPTION_KEY`
 */
export function encryptPlaidAccessToken(accessToken: string): string {
  if (!accessToken) {
    throw new Error('encryptPlaidAccessToken: accessToken must be non-empty');
  }

  const aesKey = randomBytes(32);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  const encryptedAesKey = publicEncrypt(
    {
      key: RSA_PUBLIC_KEY_PEM,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey,
  );

  const envelope = {
    version: 1,
    encrypted_aes_key: encryptedAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

/**
 * Decrypt a Plaid access-token envelope produced by `encryptPlaidAccessToken`.
 * Returns the plaintext token, or `null` if the envelope is malformed, the
 * decryption key is unavailable, or the GCM authentication tag is invalid
 * (which indicates tampering or wrong key).
 */
export function decryptPlaidAccessToken(envelope: string): string | null {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) {
    log.error('CLAUDE_CREDENTIAL_DECRYPTION_KEY is not set; cannot decrypt Plaid token');
    return null;
  }
  return decryptCredentialEnvelope(envelope, decryptionKey);
}

/**
 * Convenience: decrypt and throw a typed error if it fails. Use in code paths
 * where a missing/invalid envelope is a programming bug (e.g., when we just
 * created the row ourselves).
 */
export function decryptPlaidAccessTokenOrThrow(envelope: string): string {
  const plaintext = decryptPlaidAccessToken(envelope);
  if (plaintext === null) {
    throw new Error('Failed to decrypt Plaid access-token envelope');
  }
  return plaintext;
}
