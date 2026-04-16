/**
 * Update the Claude Code OAuth token in the local DB.
 * Reads the fresh token from macOS keychain, re-encrypts it,
 * and writes it to the Integration row.
 *
 * Usage: DATABASE_URL=... DIRECT_URL=... npx tsx back-end/scripts/update-claude-token.ts
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import * as crypto from 'crypto';

const prisma = new PrismaClient();
const decryptionKeyB64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY!;
const privateKeyPem = Buffer.from(decryptionKeyB64, 'base64').toString('utf8');

function getKeychainToken(): string {
  const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  const parsed = JSON.parse(raw);
  const token = parsed?.claudeAiOauth?.accessToken;
  if (!token) throw new Error('No claudeAiOauth.accessToken in keychain');
  return token;
}

function decryptEnvelope(encryptedB64: string): string {
  const envelopeJson = Buffer.from(encryptedB64, 'base64').toString('utf8');
  const env = JSON.parse(envelopeJson);
  const aesKey = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(env.encrypted_aes_key, 'base64')
  );
  // Auth tag is appended to ciphertext (last 16 bytes), matching claudeCredentials.ts
  const ciphertextWithTag = Buffer.from(env.ciphertext, 'base64');
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function encryptEnvelope(plaintext: string): string {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  let ct = cipher.update(plaintext, 'utf8');
  ct = Buffer.concat([ct, cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Append auth tag to ciphertext, matching the format decryptCredentialEnvelope expects
  const ciphertextWithTag = Buffer.concat([ct, authTag]);
  const pubKey = crypto.createPublicKey(privateKeyPem);
  const encAesKey = crypto.publicEncrypt(
    { key: pubKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  const envelope = {
    version: 1,
    encrypted_aes_key: encAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertextWithTag.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

async function main() {
  const freshToken = getKeychainToken();
  console.log(`Fresh token: ${freshToken.slice(0, 25)}...`);

  const integration = await prisma.integration.findFirst({
    where: { userId: '1f85ff25-6e29-4c1b-8739-f917bd101a30', name: 'claude_code' },
  });
  if (!integration) throw new Error('No claude_code integration');

  const config = integration.config as Record<string, unknown>;
  const oldEncrypted = config.encryptedCredentials as string;

  // Decrypt, swap token, re-encrypt
  const oldPlain = decryptEnvelope(oldEncrypted);
  const parsed = JSON.parse(oldPlain);
  console.log(`Old token:   ${parsed.claudeAiOauth?.accessToken?.slice(0, 25)}...`);
  parsed.claudeAiOauth.accessToken = freshToken;
  const newEncrypted = encryptEnvelope(JSON.stringify(parsed));

  await prisma.integration.update({
    where: { id: integration.id },
    data: { config: { encryptedCredentials: newEncrypted } },
  });

  // Verify round-trip
  const verify = await prisma.integration.findFirst({ where: { id: integration.id } });
  const vConfig = verify!.config as Record<string, unknown>;
  const vPlain = decryptEnvelope(vConfig.encryptedCredentials as string);
  const vParsed = JSON.parse(vPlain);
  console.log(`Verified:    ${vParsed.claudeAiOauth.accessToken.slice(0, 25)}...`);
  console.log('✅ Token updated');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
