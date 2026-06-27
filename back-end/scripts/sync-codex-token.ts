/**
 * Sync the local Codex ChatGPT auth envelope into the backend gpt_code integration.
 *
 * This reads ~/.codex/auth.json, validates that it contains ChatGPT access and
 * refresh tokens, encrypts the full envelope with the backend credential public
 * key, and upserts the gpt_code Integration row for the target user.
 *
 * Usage:
 *   DATABASE_URL=... DIRECT_URL=... CLAUDE_CREDENTIAL_DECRYPTION_KEY=... \
 *   npx tsx back-end/scripts/sync-codex-token.ts
 *
 * Optional env:
 *   CODEX_AUTH_PATH=/path/to/auth.json
 *   CODEX_TOKEN_USER_ID=<user id>
 *   CODEX_TOKEN_POOLING_ENABLED=true
 */
import 'dotenv/config';
import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DEFAULT_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

const prisma = new PrismaClient();
const decryptionKeyB64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
const codexAuthPath = process.env.CODEX_AUTH_PATH ?? join(homedir(), '.codex', 'auth.json');
const userId = process.env.CODEX_TOKEN_USER_ID ?? DEFAULT_USER_ID;
const poolingEnabled = process.env.CODEX_TOKEN_POOLING_ENABLED === 'true';

if (!decryptionKeyB64) {
  console.error('CLAUDE_CREDENTIAL_DECRYPTION_KEY is required.');
  process.exit(1);
}

function privateKeyPem(): string {
  return Buffer.from(decryptionKeyB64!, 'base64').toString('utf8');
}

function validateCodexAuth(raw: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Codex auth file is not valid JSON.');
  }

  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  if (parsed.auth_mode !== 'chatgpt') {
    throw new Error('Codex auth file is not for auth_mode=chatgpt. Run `codex login` first.');
  }
  if (
    typeof tokens?.access_token !== 'string' ||
    tokens.access_token.length === 0 ||
    typeof tokens.refresh_token !== 'string' ||
    tokens.refresh_token.length === 0
  ) {
    throw new Error('Codex auth file is missing access_token or refresh_token.');
  }
}

function encryptCredentialEnvelope(plaintext: string): string {
  const privateKey = privateKeyPem();
  const publicKey = crypto.createPublicKey(privateKey);
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const ciphertextWithTag = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: encryptedAesKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertextWithTag.toString('base64'),
    })
  ).toString('base64');
}

async function ensureUserExists(): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { userId } });
  if (existing) return;
  await prisma.user.create({
    data: {
      userId,
      name: 'E2E Browser Auth',
      systemName: 'Rose',
      onboardingCompletedAt: new Date(),
    },
  });
}

async function main() {
  const raw = readFileSync(codexAuthPath, 'utf8').trim();
  validateCodexAuth(raw);
  const encryptedCredentials = encryptCredentialEnvelope(raw);
  await ensureUserExists();

  const integration = await prisma.integration.upsert({
    where: { userId_name: { userId, name: 'gpt_code' } },
    create: {
      userId,
      name: 'gpt_code',
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
      config: { encryptedCredentials },
      poolingEnabled,
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
      poolingEnabled,
      rateLimitedUntil: null,
      failureReason: null,
    },
  });

  console.log(
    JSON.stringify({
      ok: true,
      integrationId: integration.id,
      userId,
      poolingEnabled,
      authPath: codexAuthPath,
    })
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await prisma.$disconnect();
    process.exit(1);
  });
