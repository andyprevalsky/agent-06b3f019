/** Browser passwords use a different key domain from backend phone/Plaid envelopes. */
import {
  generateKeyPairSync,
  randomBytes,
  createCipheriv,
  publicEncrypt,
  constants,
} from 'node:crypto';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateB64 = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString(
  'base64'
);
export function useSavedPaymentFixture() {
  const old = process.env.PAYMENT_DECRYPTION_KEY;
  process.env.PAYMENT_DECRYPTION_KEY = privateB64;
  return () => {
    if (old === undefined) delete process.env.PAYMENT_DECRYPTION_KEY;
    else process.env.PAYMENT_DECRYPTION_KEY = old;
  };
}
export function encryptSavedFixture(text: string) {
  const key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: publicEncrypt(
        { key: pair.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        key
      ).toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    })
  ).toString('base64');
}
