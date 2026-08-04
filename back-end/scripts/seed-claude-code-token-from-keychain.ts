/**
 * One-shot: encrypt the local macOS keychain Claude Code envelope and upsert
 * the `claude_code` Integration row for the target user. Mirrors how
 * sync-codex-token.ts seeds gpt_code, but for the Claude path.
 *
 * Usage:
 *   DATABASE_URL=... DIRECT_URL=... npx tsx \
 *     back-end/scripts/seed-claude-code-token-from-keychain.ts
 *
 * CLAUDE_CREDENTIAL_DECRYPTION_KEY comes from back-end/.env unless the caller
 * exports it; explicit process env always wins, so a caller can still point the
 * seed at a different database than the .env default.
 */
import 'dotenv/config';

import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import * as crypto from 'crypto';

const DEFAULT_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const prisma = new PrismaClient();
const decryptionKeyB64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
const userId = process.env.CLAUDE_TOKEN_USER_ID ?? DEFAULT_USER_ID;

if (!decryptionKeyB64) {
  console.error('CLAUDE_CREDENTIAL_DECRYPTION_KEY required');
  process.exit(1);
}

function privateKeyPem(): string {
  return Buffer.from(decryptionKeyB64!, 'base64').toString('utf8');
}

function encryptCredentialEnvelope(plaintext: string): string {
  const privateKey = privateKeyPem();
  const publicKey = crypto.createPublicKey(privateKey);
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const ctWithTag = Buffer.concat([ct, cipher.getAuthTag()]);
  const encAesKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: encAesKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ctWithTag.toString('base64'),
    })
  ).toString('base64');
}

function getKeychainEnvelope(): string {
  const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  const parsed = JSON.parse(raw);
  if (!parsed?.claudeAiOauth?.accessToken) {
    throw new Error('Keychain entry missing claudeAiOauth.accessToken');
  }
  // Persist a minimal envelope shaped like what update-claude-token.ts decodes.
  return JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth });
}

async function ensureUserExists(): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { userId } });
  if (existing) return;
  await prisma.user.create({
    data: {
      userId,
      name: 'Andy Prevalsky (local seed)',
      systemName: 'Rose',
      onboardingCompletedAt: new Date(),
    },
  });
}

async function main(): Promise<void> {
  const plaintext = getKeychainEnvelope();
  const encryptedCredentials = encryptCredentialEnvelope(plaintext);
  await ensureUserExists();

  const integration = await prisma.integration.upsert({
    where: { userId_name: { userId, name: 'claude_code' } },
    create: {
      userId,
      name: 'claude_code',
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
      config: { encryptedCredentials },
      rateLimitedUntil: null,
      failureReason: null,
    },
    update: {
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
      config: { encryptedCredentials },
      rateLimitedUntil: null,
      failureReason: null,
      lastUsedAt: null,
    },
  });

  console.log(
    JSON.stringify({
      ok: true,
      integrationId: integration.id,
      userId,
      preservedOtherProviders: true,
    })
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    await prisma.$disconnect();
    process.exit(1);
  });
