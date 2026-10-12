/**
 * At-rest credential envelope shared by every writer of BrowserPassword /
 * PasskeyCredential secrets (browser uploads, Apple Passwords CSV, benchmark
 * sign-in fixtures). Agent workers decrypt it with the matching RSA private key.
 */

import { randomBytes, createCipheriv, publicEncrypt, constants } from './crypto';
import { RSA_PUBLIC_KEY_PEM } from './encryptionKeys';

/**
 * Encrypt a password using RSA-2048 + AES-256-GCM hybrid encryption.
 */
export function encryptPasswordForStorage(password: string): string {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  const encryptedAesKey = publicEncrypt(
    {
      key: RSA_PUBLIC_KEY_PEM,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  const envelope = {
    version: 1,
    encrypted_aes_key: encryptedAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}
