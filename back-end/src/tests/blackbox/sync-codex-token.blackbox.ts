#!/usr/bin/env tsx

/**
 * sync-codex-token.ts must leave exactly one live gpt_code lineage per ChatGPT
 * account. The coverage database had a CONNECTED account-keyed row (an older
 * lineage) beside the '' row this script wrote; least-recently-used serving then
 * alternated onto the dead copy and the Codex E2B smoke failed with
 * refresh_token_reused on every other run.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IntegrationStatus, IntegrationType, PrismaClient } from '@prisma/client';

const tsxCli = require.resolve('tsx/cli');
const LOCAL_DB_URL =
  process.env.BLACKBOX_TEST_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  'postgresql://postgres:postgres@localhost:5432/victoria?schema=public';
const TEST_USER_ID = 'c0dec0de-5c0d-4000-8000-000000000001';
const ACCOUNT_ID = 'acct-sync-codex-blackbox-a';
const OTHER_ACCOUNT_ID = 'acct-sync-codex-blackbox-b';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function decryptEnvelope(encrypted: string, privateKeyPem: string): string {
  const envelope = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8')) as {
    encrypted_aes_key: string;
    iv: string;
    ciphertext: string;
  };
  const aesKey = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(envelope.encrypted_aes_key, 'base64')
  );
  const sealed = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    aesKey,
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.integration.deleteMany({ where: { userId: TEST_USER_ID } });
  await prisma.user.deleteMany({ where: { userId: TEST_USER_ID } });
}

async function testSyncLeavesOneLiveLineagePerAccount(withAccountRow: boolean): Promise<void> {
  const host = new URL(LOCAL_DB_URL).hostname.toLowerCase();
  assert(
    host === 'localhost' || host === '127.0.0.1',
    `sync-codex-token blackbox requires local Postgres, got ${host}`
  );
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const prisma = new PrismaClient({ datasources: { db: { url: LOCAL_DB_URL } } });
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'sync-codex-token-'));
  try {
    await cleanup(prisma);
    await prisma.user.create({
      data: { userId: TEST_USER_ID, name: 'Sync Codex Blackbox', systemName: 'Rose' },
    });
    const seed = (accountId: string, marker: string) =>
      prisma.integration.create({
        data: {
          userId: TEST_USER_ID,
          name: 'gpt_code',
          accountId,
          type: IntegrationType.TOOL_SETUP,
          status: IntegrationStatus.CONNECTED,
          isActive: true,
          config: { encryptedCredentials: marker },
        },
      });
    // With an account-keyed row the sync updates it; without one (only the
    // legacy '' row) it must create the account-keyed row, not collide on ''.
    const staleSameAccount = withAccountRow ? await seed(ACCOUNT_ID, 'stale-lineage') : null;
    const legacyBlank = await seed('', 'legacy-blank-lineage');
    const otherAccount = await seed(OTHER_ACCOUNT_ID, 'other-account-lineage');

    const authPath = join(fixtureRoot, 'auth.json');
    const authJson = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'fresh-access-token',
        refresh_token: 'fresh-refresh-token',
        account_id: ACCOUNT_ID,
      },
      last_refresh: '2026-10-02T15:01:16.705351Z',
    });
    writeFileSync(authPath, authJson);

    const result = spawnSync(process.execPath, [tsxCli, 'scripts/sync-codex-token.ts'], {
      cwd: resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        DATABASE_URL: LOCAL_DB_URL,
        DIRECT_URL: LOCAL_DB_URL,
        CODEX_AUTH_PATH: authPath,
        CODEX_TOKEN_USER_ID: TEST_USER_ID,
        CLAUDE_CREDENTIAL_DECRYPTION_KEY: Buffer.from(privateKeyPem).toString('base64'),
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert(result.status === 0, `expected sync to succeed:\n${output}`);

    const rows = await prisma.integration.findMany({
      where: { userId: TEST_USER_ID, name: 'gpt_code' },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const live = rows.filter(
      (row) => row.status === IntegrationStatus.CONNECTED && row.accountId !== OTHER_ACCOUNT_ID
    );
    assert(
      live.length === 1 &&
        live[0].accountId === ACCOUNT_ID &&
        (staleSameAccount === null || live[0].id === staleSameAccount.id),
      `expected only the account-keyed row to stay live, got ${JSON.stringify(
        live.map((row) => ({ id: row.id, accountId: row.accountId }))
      )}`
    );
    const encrypted = (live[0].config as { encryptedCredentials?: string }).encryptedCredentials;
    assert(typeof encrypted === 'string', 'expected the live row to hold an encrypted envelope');
    assert(
      decryptEnvelope(encrypted, privateKeyPem) === authJson,
      'expected the live row to hold the freshly synced auth envelope'
    );

    const retired = byId.get(legacyBlank.id);
    assert(
      retired?.status === IntegrationStatus.EXPIRED && retired.isActive === false,
      `expected the legacy '' copy of the same account to be retired, got ${retired?.status}`
    );
    const untouched = byId.get(otherAccount.id);
    assert(
      untouched?.status === IntegrationStatus.CONNECTED &&
        (untouched.config as { encryptedCredentials?: string }).encryptedCredentials ===
          'other-account-lineage',
      'expected a different ChatGPT account to stay connected and unchanged'
    );
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testSyncLeavesOneLiveLineagePerAccount(true);
  process.stdout.write(
    'PASS sync-codex-token refreshes the account row and retires stale copies\n'
  );
  await testSyncLeavesOneLiveLineagePerAccount(false);
  process.stdout.write('PASS sync-codex-token creates the account row beside a legacy blank row\n');
}

main().catch((error) => {
  process.stderr.write('FAIL sync-codex-token blackbox\n');
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
