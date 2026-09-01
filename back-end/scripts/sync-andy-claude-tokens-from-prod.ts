/**
 * Refresh Andy Prevalsky's production claude_code integration rows into the
 * local test database. Used by the Claude Code E2B smoke when local/keychain
 * credentials are missing or Anthropic rejects them as expired/revoked.
 *
 * Scope is intentionally narrow: only user 1f85ff25… (+19729777432), never
 * other users' pool tokens.
 *
 * Usage:
 *   DATABASE_URL=postgresql://.../victoria npx tsx scripts/sync-andy-claude-tokens-from-prod.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient, type Prisma } from '@prisma/client';
import dotenv from 'dotenv';

import { syncIntegrationCredentials } from './seed-local-credentials';
import { selectRemoteDatabaseUrl } from './seed-remote-database-url';
import { createRetryableProbe } from './retryable-probe';

export const ANDY_CLAUDE_SMOKE_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
export const ANDY_CLAUDE_SMOKE_PHONE_SUFFIX = '9729777432';
export const ANDY_CLAUDE_SMOKE_EXPECTED_KEY_COUNT = 2;

const PROD_INTEGRATION_COLUMNS = {
  id: true,
  userId: true,
  type: true,
  name: true,
  status: true,
  isActive: true,
  lastSyncAt: true,
  lastSuccessfulSyncAt: true,
  lastFailedSyncAt: true,
  failureReason: true,
  config: true,
  poolingEnabled: true,
  rateLimitedUntil: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PROD_INTEGRATION_COLUMNS_WITH_ACCOUNT = {
  ...PROD_INTEGRATION_COLUMNS,
  accountId: true,
  accountEmail: true,
} as const;

type ProdIntegrationRow = Prisma.IntegrationGetPayload<{
  select: typeof PROD_INTEGRATION_COLUMNS_WITH_ACCOUNT;
}>;

export interface SyncAndyClaudeResult {
  syncedCount: number;
  expectedMinKeys: number;
  userId: string;
  phoneVerified: boolean;
  integrationAccountIds: string[];
}

function normalizePhoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

function loadProdDatabaseUrl(): string {
  const envPath = resolve(__dirname, '..', '.env');
  const envVars = dotenv.parse(readFileSync(envPath));
  const remoteUrl = selectRemoteDatabaseUrl({
    ...envVars,
    SEED_REMOTE_DATABASE_URL: process.env.SEED_REMOTE_DATABASE_URL,
  });
  if (!remoteUrl) {
    throw new Error(
      'No production DATABASE_URL found in back-end/.env (required for Andy Claude token sync)'
    );
  }
  return remoteUrl;
}

export async function syncAndyClaudeTokensFromProd(options?: {
  localDatabaseUrl?: string;
  expectedMinKeys?: number;
}): Promise<SyncAndyClaudeResult> {
  const localUrl = options?.localDatabaseUrl ?? process.env.DATABASE_URL;
  if (!localUrl) {
    throw new Error('DATABASE_URL is required to sync Andy Claude tokens into the local test DB');
  }

  const remoteUrl = loadProdDatabaseUrl();
  const remote = new PrismaClient({ datasources: { db: { url: remoteUrl } } });
  const local = new PrismaClient({ datasources: { db: { url: localUrl } } });

  const remoteHasIntegrationAccountColumns = createRetryableProbe(async () => {
    const rows = await remote.$queryRaw<Array<{ columnCount: number }>>`
      SELECT COUNT(*)::int AS "columnCount"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Integration'
        AND column_name IN ('accountId', 'accountEmail')
    `;
    return rows[0]?.columnCount === 2;
  });

  try {
    await remote.$queryRaw`SELECT 1`;

    const user = await remote.user.findUnique({
      where: { userId: ANDY_CLAUDE_SMOKE_USER_ID },
      select: { userId: true, phone: true },
    });
    if (!user) {
      throw new Error(`Andy user ${ANDY_CLAUDE_SMOKE_USER_ID} not found in production`);
    }

    const phoneDigits = normalizePhoneDigits(user.phone);
    const phoneVerified =
      phoneDigits.endsWith(ANDY_CLAUDE_SMOKE_PHONE_SUFFIX) ||
      phoneDigits.endsWith(`1${ANDY_CLAUDE_SMOKE_PHONE_SUFFIX}`);
    if (!phoneVerified) {
      throw new Error(
        `Refusing prod Claude sync: user ${ANDY_CLAUDE_SMOKE_USER_ID} phone ` +
          `${JSON.stringify(user.phone)} does not match +1${ANDY_CLAUDE_SMOKE_PHONE_SUFFIX}`
      );
    }

    const where: Prisma.IntegrationWhereInput = {
      userId: ANDY_CLAUDE_SMOKE_USER_ID,
      name: 'claude_code',
      status: 'CONNECTED',
    };

    const integrations: ProdIntegrationRow[] = (await remoteHasIntegrationAccountColumns())
      ? await remote.integration.findMany({
          where,
          select: PROD_INTEGRATION_COLUMNS_WITH_ACCOUNT,
        })
      : (
          await remote.integration.findMany({
            where,
            select: PROD_INTEGRATION_COLUMNS,
          })
        ).map((row) => ({ ...row, accountId: '', accountEmail: null }));

    const credentialed = integrations.filter((integration) => {
      const config = integration.config;
      if (!config || typeof config !== 'object') return false;
      const encryptedCredentials = (config as Record<string, unknown>).encryptedCredentials;
      return typeof encryptedCredentials === 'string' && encryptedCredentials.length > 0;
    });

    if (credentialed.length === 0) {
      throw new Error(
        `No connected claude_code integrations with credentials found for Andy in production`
      );
    }

    const expectedMinKeys = options?.expectedMinKeys ?? ANDY_CLAUDE_SMOKE_EXPECTED_KEY_COUNT;
    if (credentialed.length < expectedMinKeys) {
      console.warn(
        `  ⚠️  Expected at least ${expectedMinKeys} Andy claude_code keys in prod; found ${credentialed.length}`
      );
    }

    const syncedIds = await syncIntegrationCredentials(local.integration, credentialed);

    const deleted = await local.integration.deleteMany({
      where: {
        userId: ANDY_CLAUDE_SMOKE_USER_ID,
        name: 'claude_code',
        id: { notIn: syncedIds.length > 0 ? syncedIds : ['__none__'] },
      },
    });
    if (deleted.count > 0) {
      console.log(`  🧹 Removed ${deleted.count} stale local Andy claude_code row(s)`);
    }

    const integrationAccountIds = credentialed.map(
      (integration) => integration.accountId || integration.accountEmail || '(default)'
    );

    console.log(
      `  ✅ Synced ${syncedIds.length} Andy claude_code key(s) from prod ` +
        `(accounts: ${integrationAccountIds.join(', ')})`
    );

    return {
      syncedCount: syncedIds.length,
      expectedMinKeys,
      userId: ANDY_CLAUDE_SMOKE_USER_ID,
      phoneVerified,
      integrationAccountIds,
    };
  } finally {
    await Promise.allSettled([remote.$disconnect(), local.$disconnect()]);
  }
}

async function main(): Promise<void> {
  const result = await syncAndyClaudeTokensFromProd();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
