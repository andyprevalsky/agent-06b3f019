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
/** Both Claude Subscription rows on Andy's account (+19729777432) in prod/UI. */
export const ANDY_CLAUDE_SMOKE_ACCOUNT_EMAILS = ['a@roselabs.ai', 'andy@hinavi.ai'] as const;

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
  integrationAccountEmails: string[];
}

function normalizePhoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

function loadProdDatabaseUrl(): string {
  const envPath = resolve(__dirname, '..', '.env');
  const envVars = dotenv.parse(readFileSync(envPath));
  const remoteUrl = selectRemoteDatabaseUrl({
    ...envVars,
    SEED_REMOTE_DATABASE_URL:
      process.env.SEED_REMOTE_DATABASE_URL?.trim() || envVars.SEED_REMOTE_DATABASE_URL,
  });
  if (!remoteUrl) {
    throw new Error(
      'No production DATABASE_URL found in back-end/.env (required for Andy Claude token sync)'
    );
  }
  return remoteUrl;
}

/** Host:port/dbname identity so pooler vs direct URLs to the same DB still match. */
export function canonicalDatabaseTarget(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname.toLowerCase();
  const defaultPort =
    parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:' ? '5432' : '';
  const port = parsed.port || defaultPort;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return `${hostname}:${port}/${database}`;
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
  if (canonicalDatabaseTarget(localUrl) === canonicalDatabaseTarget(remoteUrl)) {
    throw new Error(
      'Refusing Andy Claude token sync: local DATABASE_URL resolves to the same database as prod. ' +
        'Point DATABASE_URL at a local/test database before syncing.'
    );
  }

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
    };

    const integrations: ProdIntegrationRow[] = (await remoteHasIntegrationAccountColumns())
      ? await remote.integration.findMany({
          where,
          select: PROD_INTEGRATION_COLUMNS_WITH_ACCOUNT,
          orderBy: [{ accountEmail: 'asc' }],
        })
      : (
          await remote.integration.findMany({
            where,
            select: PROD_INTEGRATION_COLUMNS,
            orderBy: [{ createdAt: 'asc' }],
          })
        ).map((row) => ({ ...row, accountId: '', accountEmail: null }));

    const credentialed = integrations.filter((integration) => {
      // Never seed revoked/expired rows into local benches — an inactive
      // Anthropic OAuth token (401 on /v1/models) will poison Claude Code
      // spawn for the whole k-run if it lands in the pool ahead of good keys.
      if (!integration.isActive || integration.status !== 'CONNECTED') return false;
      const config = integration.config;
      if (!config || typeof config !== 'object') return false;
      const encryptedCredentials = (config as Record<string, unknown>).encryptedCredentials;
      return typeof encryptedCredentials === 'string' && encryptedCredentials.length > 0;
    });

    if (credentialed.length === 0) {
      // Clear stale local rows before failing — otherwise revoked/expired
      // credentials from a prior sync remain in the local pool (CodeRabbit #1260).
      const cleared = await local.integration.deleteMany({
        where: {
          userId: ANDY_CLAUDE_SMOKE_USER_ID,
          name: 'claude_code',
        },
      });
      if (cleared.count > 0) {
        console.log(
          `  🧹 Removed ${cleared.count} stale local Andy claude_code row(s) (no eligible prod credentials)`
        );
      }
      throw new Error(`No claude_code integrations with credentials found for Andy in production`);
    }

    const integrationAccountEmails = credentialed.map(
      (integration) => integration.accountEmail ?? integration.accountId ?? '(default)'
    );
    const missingExpectedEmails = ANDY_CLAUDE_SMOKE_ACCOUNT_EMAILS.filter(
      (email) => !integrationAccountEmails.includes(email)
    );
    if (missingExpectedEmails.length > 0) {
      console.warn(
        `  ⚠️  Andy Claude subscription missing prod key(s): ${missingExpectedEmails.join(', ')}`
      );
    }

    const expectedMinKeys = options?.expectedMinKeys ?? ANDY_CLAUDE_SMOKE_EXPECTED_KEY_COUNT;
    if (credentialed.length < expectedMinKeys) {
      console.warn(
        `  ⚠️  Expected at least ${expectedMinKeys} Andy claude_code keys in prod; found ${credentialed.length}`
      );
    }

    for (const integration of credentialed) {
      const email = integration.accountEmail ?? integration.accountId ?? '(default)';
      console.log(
        `  ↳ prod claude_code ${email} status=${integration.status} pooling=${integration.poolingEnabled}`
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

    console.log(
      `  ✅ Synced ${syncedIds.length} Andy claude_code key(s) from prod ` +
        `(accounts: ${integrationAccountEmails.join(', ')})`
    );

    return {
      syncedCount: syncedIds.length,
      expectedMinKeys,
      userId: ANDY_CLAUDE_SMOKE_USER_ID,
      phoneVerified,
      integrationAccountEmails,
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
