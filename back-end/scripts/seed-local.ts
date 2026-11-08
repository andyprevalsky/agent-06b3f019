/**
 * Sync user data from the remote (production) Supabase database to the local Postgres.
 *
 * Reads the remote DATABASE_URL from back-end/.env (since run.sh overrides
 * process.env.DATABASE_URL to point to local). Syncs all user-scoped data for
 * the dev user without overwriting locally-spawned agents.
 *
 * Usage: DATABASE_URL=<local_url> npx tsx scripts/seed-local.ts
 */

import { writeFileSync } from 'node:fs';

import { PrismaClient, type Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';
import {
  syncBrowserPasswordCredentials,
  syncBrowserPermissionCredentials,
  syncCookieBundleCredentials,
  syncIntegrationCredentials,
  syncPagedCredentials,
  ORIGIN_META_SELECT,
  syncPasskeyCredentialRows,
  syncRequiredCredentialTable,
  syncSteelSessionAuthCredentials,
} from './seed-local-credentials';
import {
  connectThenOpen,
  runSyncStep,
  syncRowsWithConcurrency,
  syncUserRecord,
  syncWaitlistAccounts,
  uniqueConflictWhere,
} from './seed-local-helpers';
import {
  createScopedBrowserAuthReaders,
  parseCookieDomains,
  passkeySyncWhere,
} from './cookie-domain-scope';
import { selectRemoteDatabaseUrl } from './seed-remote-database-url';
import { streamCookies, streamJsonbOrigins, type JsonbOriginTable } from './seed-jsonb-stream';
import { createRetryableProbe } from './retryable-probe';
import {
  SEED_PEAK_RSS_BUDGET_MB,
  SEED_RSS_REPORT_ENV,
  withinSeedBudget,
  type SeedRssReport,
} from '../src/providers/seedMemoryBudget';

const COMPUTE_TOKENS_ONLY = process.argv.includes('--compute-tokens-only');
const COMPUTE_TOKEN_SOURCE_DATABASE_URL =
  process.env.SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL?.trim();

if (COMPUTE_TOKENS_ONLY && !COMPUTE_TOKEN_SOURCE_DATABASE_URL) {
  throw new Error(
    '--compute-tokens-only requires SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL; refusing to fall back to .env'
  );
}

// Parse .env directly to get the normal remote DB URL. Operators may route
// that same trusted connection through a local tunnel without editing .env.
// (process.env.DATABASE_URL is already overridden to local by run.sh). Isolated
// benchmark runs may explicitly source compute tokens from the already-verified
// shared workspace DB so a production-side cooldown cannot invalidate a local
// deploy gate.
const envPath = resolve(__dirname, '..', '.env');
const envVars = COMPUTE_TOKENS_ONLY ? {} : dotenv.parse(readFileSync(envPath));
// SEED_REMOTE_DATABASE_URL overrides the source database.
//
// The seed normally reads prod via .env, which makes any measurement of its
// footprint depend on outbound reachability: on 2026-07-29 every host in .env
// was TCP-closed locally and 10 consecutive runs died in ~4s, producing a
// "122MB peak" that was really the cost of failing. Pointing the source at a
// local restore of the same prod dump exercises the identical code path and row
// counts with no network in the loop. Never set in prod.
const REMOTE_URL = COMPUTE_TOKENS_ONLY
  ? COMPUTE_TOKEN_SOURCE_DATABASE_URL
  : selectRemoteDatabaseUrl({
      ...envVars,
      SEED_REMOTE_DATABASE_URL: process.env.SEED_REMOTE_DATABASE_URL,
    });
const LOCAL_URL = process.env.DATABASE_URL;

if (!REMOTE_URL) {
  console.error('❌ No remote DATABASE_URL found in .env');
  process.exit(1);
}
if (!LOCAL_URL) {
  console.error('❌ No local DATABASE_URL found in the environment');
  process.exit(1);
}

const DEFAULT_DEV_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
// SEED_LOCAL_USER_ID retargets the whole prod→local sync at another REAL
// production identity, the same way SEED_COOKIE_DOMAINS scopes it to a subset
// of domains. Benchmarks that must run as a specific person (a non-admin payer,
// a different storefront's account) need that person's rows in the isolated DB;
// without this every sync mode silently resolved to the dev user, so a task
// launched with BENCHMARK_RUN_USER_ID hit
// `Foreign key constraint violated: AgentIdentity_userId_fkey` at browser-session
// init because the identity it ran as had no local User row at all.
const SEED_USER_ID = process.env.SEED_LOCAL_USER_ID?.trim() || DEFAULT_DEV_USER_ID;
// Merge production browser auth state into local by each table's natural
// identity. Matching rows are refreshed and missing production rows are added;
// local-only rows are deliberately preserved by normal/full sync. The explicit
// --passkeys-only benchmark mode is authoritative and removes stale local
// passkeys so its live-fixture preflight cannot succeed on obsolete material.
const CREDENTIALS_ONLY = process.argv.includes('--credentials-only');
// Refresh Gmail/Yahoo integration rows + EmailIntegrationCredential tokens from
// prod. The canonical base-image dump can freeze abandoned OAuth rows
// (null email / null accessToken); cache-coverage and any message_person email
// path then fail closed with "Missing from_email" because Connected Integrations
// never lists a usable send-from address. Benchmark runs that need email pull
// this overlay the same way compute tokens are refreshed.
const EMAIL_CREDENTIALS_ONLY = process.argv.includes('--email-credentials-only');
const SKIP_BROWSER_AUTH_SYNC =
  process.env.BENCHMARK_SKIP_BROWSER_AUTH_SYNC === '1' ||
  process.env.BENCHMARK_WORLD_MODEL_MODE === 'simulate';
// Refresh ONLY the compute-token integrations (claude_code / gpt_code, the
// dev user's own + the shared pool) from prod. Benchmark runs invoke this at
// task setup so a frozen DB fixture or whole-DB snapshot restore can never
// leave the isolated DB with a stale/expired compute token — otherwise the
// agent's claudeAuth fetch fails and every LLM call falls through to the paid
// waterfall.
const PASSKEYS_ONLY = process.argv.includes('--passkeys-only');
const COMPUTE_TOKEN_SYNC_ATTEMPTS = 5;
const COMPUTE_TOKEN_REQUIRED_TYPES = parseComputeTokenRequiredTypes(
  process.env.SEED_REQUIRE_COMPUTE_TOKEN_TYPES
);
const POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS =
  process.env.SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS === '1';
const ISOLATED_BENCHMARK_RUN = process.env.BENCHMARK_ISOLATED_RUN === 'true';
const COMPUTE_INTEGRATION_NAMES = ['claude_code', 'gpt_code'] as const;
let activeRemotePoolIntegrationIds = new Set<string>();

// SEED_COOKIE_DOMAINS scopes every domain-bearing browser-auth table to the
// domains a benchmark task needs. Set by run_benchmark from the task's
// environment.live_cookie_domains. Empty → full browser-auth graph. Filter
// logic lives in cookie-domain-scope.ts and is pinned by blackbox coverage.
const SEED_COOKIE_DOMAINS = parseCookieDomains(process.env.SEED_COOKIE_DOMAINS);

function positivePageSize(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${process.env[name]}`);
  }
  return value;
}

// Cookies are streamed with COPY rather than paged through Prisma, so there is
// no SEED_COOKIE_PAGE_SIZE knob to honour here; DEFAULT_COOKIE_PAGE_SIZE remains
// the bounded default for callers that page the cookie selector directly.
const PERSON_PAGE_SIZE = positivePageSize('SEED_PERSON_PAGE_SIZE', 50);
const MESSAGE_PAGE_SIZE = positivePageSize('SEED_MESSAGE_PAGE_SIZE', 50);
const CREDENTIAL_PAGE_SIZE = positivePageSize('SEED_CREDENTIAL_PAGE_SIZE', 50);

const requestedSeedModes = [
  ['--compute-tokens-only', COMPUTE_TOKENS_ONLY],
  ['--passkeys-only', PASSKEYS_ONLY],
  ['--credentials-only', CREDENTIALS_ONLY],
  ['--email-credentials-only', EMAIL_CREDENTIALS_ONLY],
].filter(([, enabled]) => enabled);
if (requestedSeedModes.length > 1) {
  throw new Error(
    `Seed modes are mutually exclusive; received ${requestedSeedModes
      .map(([flag]) => flag)
      .join(', ')}`
  );
}

const remote = new PrismaClient({ datasources: { db: { url: REMOTE_URL } } });
// Pin the local URL the same way as remote. Relying on process.env.DATABASE_URL
// at query time fails under --compute-tokens-only when Prisma re-validates
// schema env("DATABASE_URL") and the engine no longer sees the parent-injected
// value (AgentCard lifecycle: "Environment variable not found: DATABASE_URL").
// Opened by openLocalClient() only after remote has connected (see connectThenOpen).
let local!: PrismaClient;
let localOpened = false;

async function openLocalClient(): Promise<void> {
  if (localOpened) return;
  local = await connectThenOpen(
    remote,
    () => new PrismaClient({ datasources: { db: { url: LOCAL_URL } } })
  );
  localOpened = true;
}
/**
 * Deterministic ordering is what makes `skip`/`take` paging safe — without it
 * Postgres may return overlapping or missing rows across pages.
 */
function pagedArgs(where: unknown, page?: { skip: number; take: number }) {
  return page
    ? { where: where as never, skip: page.skip, take: page.take, orderBy: { id: 'asc' as const } }
    : { where: where as never };
}

/**
 * Origin pages carry identity + `hash` only. The payload column is fetched
 * separately, as text, and only for rows whose hash actually changed — see
 * `syncOriginBlobCredentials`.
 */
function pagedOriginArgs(where: unknown, page?: { skip: number; take: number }) {
  return { ...pagedArgs(where, page), select: ORIGIN_META_SELECT };
}

const scopedRemoteBrowserAuth = createScopedBrowserAuthReaders(
  {
    cookie: (where, page) => remote.cookie.findMany(pagedArgs(where, page)),
    cookieBundle: (where, page) => remote.cookieBundle.findMany(pagedArgs(where, page)),
    steelSessionAuth: (where, page) => remote.steelSessionAuth.findMany(pagedArgs(where, page)),
    localStorageOrigin: (where, page) =>
      remote.localStorageOrigin.findMany(pagedOriginArgs(where, page)),
    indexedDBOrigin: (where, page) => remote.indexedDBOrigin.findMany(pagedOriginArgs(where, page)),
    browserPermission: (where, page) => remote.browserPermission.findMany(pagedArgs(where, page)),
    cacheStorageOrigin: (where, page) =>
      remote.cacheStorageOrigin.findMany(pagedOriginArgs(where, page)),
    browserPassword: (where, page) => remote.browserPassword.findMany(pagedArgs(where, page)),
    passkeyCredential: (where, page) => remote.passkeyCredential.findMany(pagedArgs(where, page)),
  },
  SEED_USER_ID,
  SEED_COOKIE_DOMAINS
);

/**
 * Peak RSS seen so far, and the worst table. Sampled around every sync step so
 * a regression names the table that caused it instead of just the total.
 *
 * The seed shares a 4GB fleet primary with Postgres, Temporal, the backend and
 * a 12-process worker pool. It was SIGKILLed there on 2026-07-29 and the box
 * was dropped from the fleet as an infra loss, with nothing recording why.
 * Enforced by src/tests/unit/seed-memory-ratchet.test.ts.
 */
/**
 * Origin tables move Postgres-to-Postgres with COPY: the payload never enters
 * the Node heap, so peak memory does not scale with row size at all.
 *
 * The paged blob path (`syncOriginBlobCredentials`) is retained and still
 * covered by its own tests, but it is NOT what the seed runs: measured on this
 * merged tree it peaks at 592MB against a 230MB budget, because a page still
 * materializes its payload in V8 before writing. COPY measures 197MB.
 */
async function syncJsonbOriginTable(table: JsonbOriginTable): Promise<number> {
  return streamJsonbOrigins({
    remoteUrl: REMOTE_URL!,
    localUrl: LOCAL_URL!,
    userId: SEED_USER_ID,
    domains: SEED_COOKIE_DOMAINS,
    table,
  });
}

const rssPeaks: Array<{ name: string; peakRssMb: number }> = [];
let peakRssMb = 0;

function sampleRss(name: string): void {
  const mb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  if (mb > peakRssMb) peakRssMb = mb;
  const existing = rssPeaks.find((entry) => entry.name === name);
  if (existing === undefined) rssPeaks.push({ name, peakRssMb: mb });
  else if (mb > existing.peakRssMb) existing.peakRssMb = mb;
}

export function seedRssReport(): SeedRssReport {
  return {
    peakRssMb,
    budgetMb: SEED_PEAK_RSS_BUDGET_MB,
    tables: [...rssPeaks].sort((a, b) => b.peakRssMb - a.peakRssMb),
  };
}

function writeRssReport(): void {
  const target = process.env[SEED_RSS_REPORT_ENV];
  const report = seedRssReport();
  const worst = report.tables[0];
  console.log(
    `  🧠 seed peak RSS: ${report.peakRssMb}MB / budget ${report.budgetMb}MB` +
      (worst ? ` (worst: ${worst.name} @ ${worst.peakRssMb}MB)` : '')
  );
  if (target !== undefined && target !== '') {
    try {
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    } catch (err) {
      console.warn(
        `  ⚠️ could not write seed RSS report: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (!withinSeedBudget(report.peakRssMb)) {
    // Loud, but NOT fatal: a seed that succeeded should not be turned into an
    // infra loss by its own instrumentation. The ratchet test is the gate.
    console.warn(
      `  ⚠️ seed peak RSS ${report.peakRssMb}MB exceeds the ${report.budgetMb}MB ratchet — ` +
        'make the seed leaner rather than raising the budget (see providers/seedMemoryBudget.ts)'
    );
  }
}

async function syncTable(name: string, fn: () => Promise<number>): Promise<void> {
  sampleRss(name);
  await runSyncStep(name, fn);
  sampleRss(name);
}

async function syncRequiredTable(
  name: string,
  fn: () => Promise<number>,
  failures?: Error[]
): Promise<void> {
  sampleRss(name);
  try {
    const count = await syncRequiredCredentialTable(name, fn);
    sampleRss(name);
    console.log(`  ✅ ${name}: ${count} synced`);
  } catch (err) {
    sampleRss(name);
    const failure = err instanceof Error ? err : new Error(String(err));
    console.error(`  ❌ ${failure.message}`);
    if (failures) {
      failures.push(failure);
      return;
    }
    throw failure;
  }
}

/**
 * Upsert prod rows into the local database keyed on primary id.
 *
 * A model can carry a compound unique key in addition to `id` (for example
 * `EmailIntegrationCredential` is unique on `(userId, provider, email)`). When a
 * stale local row holds the same tuple under a DIFFERENT primary key, the
 * id-keyed upsert falls through to `create` and dies on P2002, which aborts the
 * entire seed and blocks every deploy from that worktree. Reconcile by updating
 * the row that already owns the tuple, preserving its local id so dependent rows
 * survive — the same treatment `syncIntegrationCredentials` gives `Integration`.
 */
async function upsertById(model: any, records: any[]): Promise<number> {
  for (const r of records) {
    const { id, ...rest } = r;
    try {
      await model.upsert({ where: { id }, create: r, update: rest });
    } catch (error) {
      const target =
        (error as { code?: string; meta?: { target?: unknown } })?.code === 'P2002'
          ? (error as { meta?: { target?: unknown } }).meta?.target
          : undefined;
      if (!Array.isArray(target) || target.length === 0 || target.includes('id')) throw error;
      // Only the CREATE branch is safe to recover. If `id` already exists then
      // the update moved that row onto a compound key owned by a different
      // local row; rewriting the other row would silently leave the row we were
      // actually asked to sync stale, so surface it instead.
      const existingById = await model.findUnique({ where: { id }, select: { id: true } });
      if (existingById) throw error;

      const fields = target as string[];
      // Refresh the conflicting row in place; its local id stays authoritative.
      // Single-field uniques (Waitlist.phone) must use a scalar where, not
      // `{ phone: { phone } }` — that Prisma shape is only for compound keys.
      await model.update({
        where: uniqueConflictWhere(fields, r as Record<string, unknown>),
        data: rest,
      });
    }
  }
  return records.length;
}

// Columns this sync reads FROM PRODUCTION. An unqualified findMany() selects
// every column in the LOCAL schema, so the moment a migration adds a column that
// prod has not deployed yet, the cold-sync dies with P2022 and every isolated
// benchmark stack fails to boot. Local-policy columns (poolingEnabledOverride)
// are deliberately absent: they are decided locally, never sourced from prod.
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

async function findProdIntegrations(
  where: Prisma.IntegrationWhereInput
): Promise<ProdIntegrationRow[]> {
  if (await remoteHasIntegrationAccountColumns()) {
    return remote.integration.findMany({
      where,
      select: PROD_INTEGRATION_COLUMNS_WITH_ACCOUNT,
    });
  }
  const rows = await remote.integration.findMany({
    where,
    select: PROD_INTEGRATION_COLUMNS,
  });
  return rows.map((row) => ({ ...row, accountId: '', accountEmail: null }));
}

function integrationPoolIdentity(row: {
  userId: string;
  name: string;
  accountId?: string | null;
}): string {
  return JSON.stringify([row.userId, row.name, row.accountId ?? '']);
}

// Keep production reads on the columns that existed before the newest local
// migration. A deploy seeds from production before that migration is live, so
// an implicit SELECT * would request the new health columns and fail with P2022.
const PROD_EMAIL_CREDENTIAL_COLUMNS = {
  id: true,
  userId: true,
  integrationId: true,
  provider: true,
  pkceVerifier: true,
  stateToken: true,
  accessToken: true,
  refreshToken: true,
  expiresAt: true,
  scopes: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  email: true,
} as const;

// Subscription.stripeLivemode shipped in migration 20260806000639. Cached seed
// dumps (and any remote that has not applied that migration yet) still omit the
// column; an unqualified findUnique() would P2022 the whole seed and block
// every deploy's seed-memory ratchet. Stable projection + capability probe
// mirrors Integration account columns / EmailCredential health columns.
const PROD_SUBSCRIPTION_COLUMNS = {
  id: true,
  userId: true,
  subscriptionTier: true,
  stripeSubscriptionId: true,
  stripeCustomerId: true,
  currentPeriodEnd: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PROD_SUBSCRIPTION_COLUMNS_WITH_LIVEMODE = {
  ...PROD_SUBSCRIPTION_COLUMNS,
  stripeLivemode: true,
} as const;

type ProdSubscriptionRow = Prisma.SubscriptionGetPayload<{
  select: typeof PROD_SUBSCRIPTION_COLUMNS_WITH_LIVEMODE;
}>;

const remoteHasSubscriptionLivemodeColumn = createRetryableProbe(async () => {
  const rows = await remote.$queryRaw<Array<{ columnCount: number }>>`
      SELECT COUNT(*)::int AS "columnCount"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Subscription'
        AND column_name = 'stripeLivemode'
    `;
  return (rows[0]?.columnCount ?? 0) === 1;
});

async function findProdSubscription(userId: string): Promise<ProdSubscriptionRow | null> {
  if (await remoteHasSubscriptionLivemodeColumn()) {
    return remote.subscription.findUnique({
      where: { userId },
      select: PROD_SUBSCRIPTION_COLUMNS_WITH_LIVEMODE,
    });
  }
  const row = await remote.subscription.findUnique({
    where: { userId },
    select: PROD_SUBSCRIPTION_COLUMNS,
  });
  if (!row) return null;
  // Local schema requires the column; sandbox is the pre-migration default.
  return { ...row, stripeLivemode: false };
}

type SyncIntegrationsOptions = {
  /**
   * Compute-token refresh must only touch `claude_code` / `gpt_code`.
   * Syncing every Integration row (historical default) restored production
   * `agentcard` CONNECTED state over the local `agentcard-setup` reset fixture,
   * so `agent-payment-setup-resume` skipped onboarding and mint 409'd with
   * `Cardholder not found` after a sibling task's compute-token overlay.
   */
  computeTokensOnly?: boolean;
};

async function syncIntegrations(options: SyncIntegrationsOptions = {}): Promise<number> {
  // Compute overlays omit agentcard so local agentcard-setup reset/complete fixtures hold.
  activeRemotePoolIntegrationIds.clear();
  const computeTokensOnly = options.computeTokensOnly === true;
  // Rotating Lantern grants stay with their dedicated owner, never a seed replica.
  // Compute overlays remain scoped to claude_code/gpt_code (+ the shared pool).
  const userIntegrations = await findProdIntegrations(
    computeTokensOnly
      ? { userId: SEED_USER_ID, name: { in: [...COMPUTE_INTEGRATION_NAMES] } }
      : { userId: SEED_USER_ID, name: { not: 'lantern_people' } }
  );
  const poolIntegrations = await findProdIntegrations({
    poolingEnabled: true,
    userId: { not: SEED_USER_ID },
    ...(computeTokensOnly
      ? { name: { in: [...COMPUTE_INTEGRATION_NAMES] } }
      : { name: { not: 'lantern_people' } }),
  });
  const previouslyPooledLocalIntegrations = await local.integration.findMany({
    where: {
      name: { in: [...COMPUTE_INTEGRATION_NAMES] },
      poolingEnabled: true,
      userId: { not: SEED_USER_ID },
    },
    select: { id: true, userId: true, name: true, accountId: true },
  });
  const previousPoolUserIds = [
    ...new Set(previouslyPooledLocalIntegrations.map((integration) => integration.userId)),
  ];
  const revokedRemoteIntegrations =
    previousPoolUserIds.length > 0
      ? await findProdIntegrations({
          name: { in: [...COMPUTE_INTEGRATION_NAMES] },
          poolingEnabled: false,
          userId: { in: previousPoolUserIds },
        })
      : [];
  const revokedRemoteIdentities = new Set(revokedRemoteIntegrations.map(integrationPoolIdentity));
  const revokedLocalIds = previouslyPooledLocalIntegrations
    .filter((integration) => revokedRemoteIdentities.has(integrationPoolIdentity(integration)))
    .map((integration) => integration.id);
  if (revokedLocalIds.length > 0) {
    const revoked = await local.integration.updateMany({
      where: { id: { in: revokedLocalIds } },
      data: { poolingEnabled: false },
    });
    console.log(`  🧹 Integrations: ${revoked.count} revoked pool token(s) disabled locally`);
  }
  const all = [...userIntegrations, ...poolIntegrations];
  // Pool tokens reference foreign users — ensure those User records exist locally
  const poolUserIds = [...new Set(poolIntegrations.map((i) => i.userId))];
  for (const uid of poolUserIds) {
    await syncUserRecord(remote.user, local.user, uid);
  }
  // Integrations are unique by (userId, name, accountId). A local credential may have a
  // different primary key from its production counterpart, so syncing by id
  // can collide with that compound key and fail every benchmark preflight.
  // Preserve the local id (and any dependent rows) while refreshing the
  // production credential fields.
  const syncedIds = await syncIntegrationCredentials(local.integration, all);
  activeRemotePoolIntegrationIds = new Set(syncedIds.slice(userIntegrations.length));
  const deleted = await local.integration.deleteMany({
    where: {
      name: { in: [...COMPUTE_INTEGRATION_NAMES] },
      id: { notIn: syncedIds.length > 0 ? syncedIds : ['__none__'] },
      OR: [{ userId: SEED_USER_ID }, { userId: { in: poolUserIds }, poolingEnabled: true }],
    },
  });
  if (deleted.count > 0) {
    console.log(`  🧹 Integrations: ${deleted.count} stale local compute tokens deleted`);
  }
  return syncedIds.length;
}

/** Email providers refreshed by `--email-credentials-only` (no compute-token churn). */
const EMAIL_INTEGRATION_NAMES = ['gmail', 'yahoo'] as const;

/**
 * Sync only Gmail/Yahoo integration rows for the selected seed user. Unlike
 * `syncIntegrations`, this never imports pool tokens and never deletes
 * `claude_code` / `gpt_code` rows — email overlay must not disturb compute
 * tokens already present in an isolated benchmark DB.
 *
 * Returns a remote-integration-id → local-integration-id map so credential
 * upserts can rewrite foreign keys onto the preserved local IDs.
 */
async function syncEmailIntegrations(): Promise<Map<string, string>> {
  const emailIntegrations = await findProdIntegrations({
    userId: SEED_USER_ID,
    name: { in: [...EMAIL_INTEGRATION_NAMES] },
  });
  const remoteToLocal = new Map<string, string>();
  for (const integration of emailIntegrations) {
    const { id: remoteId, ...updateData } = integration;
    const accountId = integration.accountId ?? '';
    const synced = await local.integration.upsert({
      where: {
        userId_name_accountId: {
          userId: integration.userId,
          name: integration.name,
          accountId,
        },
      },
      create: { ...integration, accountId },
      update: { ...updateData, accountId },
      select: { id: true },
    });
    remoteToLocal.set(remoteId, synced.id);
  }
  return remoteToLocal;
}

/**
 * Rewrite credential.integrationId onto the local Integration id when IDs diverge.
 * Production may not have the health columns yet, so every authoritative sync
 * must also clear stale local failures instead of preserving them through upsert.
 */
function remapEmailCredentialIntegrationIds<
  T extends { integrationId: string; [key: string]: unknown },
>(creds: T[], remoteToLocal: Map<string, string>): T[] {
  return creds.map((cred) => ({
    ...cred,
    integrationId: remoteToLocal.get(cred.integrationId) ?? cred.integrationId,
    state: 'connected',
    lastErrorReason: null,
    lastFailedSyncAt: null,
  }));
}

/**
 * Build remote→local Integration id map for the email providers that own
 * EmailIntegrationCredential rows. Used after any integration sync that
 * preserves local primary keys via (userId, name).
 */
async function emailIntegrationIdMap(): Promise<Map<string, string>> {
  const remoteRows = await findProdIntegrations({
    userId: SEED_USER_ID,
    name: { in: [...EMAIL_INTEGRATION_NAMES] },
  });
  const remoteToLocal = new Map<string, string>();
  for (const row of remoteRows) {
    const localRow = await local.integration.findUnique({
      where: {
        userId_name_accountId: {
          userId: row.userId,
          name: row.name,
          accountId: row.accountId,
        },
      },
      select: { id: true },
    });
    if (localRow) remoteToLocal.set(row.id, localRow.id);
  }
  return remoteToLocal;
}

/**
 * Synthetic benchmark users must not receive copies of the developer's credential rows. For
 * isolated benchmark databases only, this explicit opt-in exposes the already-synced dev-owned
 * provider through the normal compute pool instead. Ownership and encrypted configuration stay
 * on the original Integration row; only its local pool eligibility changes.
 */
async function poolRequiredDevComputeTokensForSyntheticUsers(): Promise<number> {
  if (!POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS) return 0;
  if (!ISOLATED_BENCHMARK_RUN) {
    console.warn(
      '  ⚠️  Compute Tokens (integrations): refusing synthetic-user pool eligibility ' +
        'outside an explicitly isolated benchmark database'
    );
    return 0;
  }

  const requiredNames = [...COMPUTE_TOKEN_REQUIRED_TYPES].map((type) =>
    type === 'claude' ? 'claude_code' : 'gpt_code'
  );
  const result = await local.integration.updateMany({
    where: {
      userId: SEED_USER_ID,
      name: { in: requiredNames },
      status: 'CONNECTED',
    },
    data: { poolingEnabled: true },
  });
  console.log(
    `  🧪 Compute Tokens (integrations): ${result.count} dev-owned row(s) made pool-eligible ` +
      'inside the isolated synthetic-user benchmark database'
  );
  return result.count;
}

// Browser auth sync shared by full sync and --credentials-only. Natural-keyed
// credentials merge production rows; provider-profile mappings are replaced so
// their BrowserContext foreign key always points at the local context row.
async function syncBrowserState(failures?: Error[]): Promise<void> {
  // ── Browser Context ──
  await syncRequiredTable(
    'Browser Context',
    async () => {
      // Select the stable cross-version columns explicitly. During a pre-deploy
      // benchmark the generated client can include a new local-only column that
      // production has not migrated yet; an implicit SELECT * would make the
      // auth-state sync fail before the migration can be exercised locally.
      const ctx = await remote.browserContext.findUnique({
        where: { userId: SEED_USER_ID },
        select: {
          id: true,
          userId: true,
          contextId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!ctx) return 0;
      const { id, ...rest } = ctx;
      await local.browserContext.upsert({
        where: { userId: SEED_USER_ID },
        create: ctx as any,
        update: rest as any,
      });
      return 1;
    },
    failures
  );

  // ── Browser Provider Profiles ──
  // BrowserProviderProfile.contextId is a foreign key to BrowserContext.id.
  // The local context may intentionally retain a different primary key than
  // production, so replace the local mappings with rows remapped to that id.
  await syncRequiredTable(
    'Browser Provider Profiles',
    async () => {
      const remoteContext = await remote.browserContext.findUnique({
        where: { userId: SEED_USER_ID },
        select: { id: true },
      });
      const localContext = await local.browserContext.findUnique({
        where: { userId: SEED_USER_ID },
        select: { id: true },
      });
      if (!remoteContext || !localContext) return 0;
      const profiles = await remote.browserProviderProfile.findMany({
        where: { contextId: remoteContext.id },
      });
      await local.$transaction(async (tx) => {
        await tx.browserProviderProfile.deleteMany({ where: { contextId: localContext.id } });
        for (const profile of profiles) {
          const { id, contextId, ...data } = profile;
          void id;
          void contextId;
          await tx.browserProviderProfile.create({
            data: { ...data, contextId: localContext.id },
          });
        }
      });
      return profiles.length;
    },
    failures
  );

  // ── Cookies ──
  // Streamed directly between Postgres processes, like the JSONB origin tables.
  // A 22k-cookie account made Prisma paging a false choice: small pages needed
  // ~880 production round trips (over the deploy stack's 120s readiness
  // contract) and large pages pushed peak RSS past the seed ratchet. One COPY
  // pays a single round trip and holds no cookie row in the V8 heap. The
  // target-side merge keeps local-only rows and pre-existing local ids, and only
  // rewrites rows whose content actually changed — the same rule the Prisma warm
  // path applied via cookieContent().
  await syncRequiredTable(
    'Cookies',
    async () => {
      const synced = await streamCookies({
        remoteUrl: REMOTE_URL!,
        localUrl: LOCAL_URL!,
        userId: SEED_USER_ID,
        domains: SEED_COOKIE_DOMAINS,
      });
      if (SEED_COOKIE_DOMAINS.length > 0) {
        process.stdout.write(
          `     scoped to ${SEED_COOKIE_DOMAINS.length} domain(s) [${SEED_COOKIE_DOMAINS.join(
            ', '
          )}] → ${synced} cookies\n`
        );
      } else if (synced > 0) {
        process.stdout.write(`     ${synced} cookies streamed in one COPY round trip\n`);
      }
      return synced;
    },
    failures
  );

  // ── Durable browser-auth references ──
  await syncRequiredTable(
    'Cookie Bundles',
    async () =>
      syncPagedCredentials(
        (page) => scopedRemoteBrowserAuth.cookieBundle(page),
        (bundles) => syncCookieBundleCredentials(local.cookieBundle, bundles),
        CREDENTIAL_PAGE_SIZE
      ),
    failures
  );

  await syncRequiredTable(
    'Steel Session Auth',
    async () => {
      const sessions = await scopedRemoteBrowserAuth.steelSessionAuth();
      return syncSteelSessionAuthCredentials(local.steelSessionAuth, sessions);
    },
    failures
  );

  // ── LocalStorage Origins ──
  // Streamed directly between Postgres processes. Row-count paging is not a
  // memory bound for JSONB: a single canonical JSON string can still exceed
  // the seed's entire budget before Prisma parses it.
  await syncRequiredTable(
    'LocalStorage',
    () => syncJsonbOriginTable('LocalStorageOrigin'),
    failures
  );

  // ── IndexedDB Origins ──
  // Few rows, but `databases` is the single largest blob in the seed (one prod
  // row is 41MB uncompressed), so its page is deliberately one row.
  await syncRequiredTable('IndexedDB', () => syncJsonbOriginTable('IndexedDBOrigin'), failures);

  // ── Browser Permissions ──
  await syncRequiredTable(
    'Browser Permissions',
    async () => {
      const perms = await scopedRemoteBrowserAuth.browserPermission();
      return syncBrowserPermissionCredentials(local.browserPermission, perms);
    },
    failures
  );

  // ── Cache Storage Origins ──
  await syncRequiredTable(
    'Cache Storage',
    () => syncJsonbOriginTable('CacheStorageOrigin'),
    failures
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasEncryptedCredentials(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const encryptedCredentials = (config as Record<string, unknown>).encryptedCredentials;
  return typeof encryptedCredentials === 'string' && encryptedCredentials.length > 0;
}

function parseComputeTokenRequiredTypes(raw: string | undefined): Set<'claude' | 'gpt'> {
  const value = raw?.trim() || 'claude,gpt';
  // "any" = at least one of claude_code / gpt_code must be usable. Used by
  // code-agent benchmarks (spawn_claude_code_agent selects Claude Code or
  // Codex from whichever compute token the run actually holds).
  if (value.toLowerCase() === 'any') {
    return new Set<'claude' | 'gpt'>(['claude', 'gpt']);
  }
  const types = new Set<'claude' | 'gpt'>();
  for (const part of value.split(',')) {
    const token = part.trim().toLowerCase();
    if (token === '') continue;
    if (token !== 'claude' && token !== 'gpt') {
      throw new Error(
        `SEED_REQUIRE_COMPUTE_TOKEN_TYPES must contain only claude,gpt,any; received ${JSON.stringify(
          raw
        )}`
      );
    }
    types.add(token);
  }
  if (types.size === 0) {
    throw new Error(
      'SEED_REQUIRE_COMPUTE_TOKEN_TYPES must require at least one compute token type'
    );
  }
  return types;
}

function requireAnyComputeTokenType(): boolean {
  return (process.env.SEED_REQUIRE_COMPUTE_TOKEN_TYPES || '').trim().toLowerCase() === 'any';
}

interface GptCodeAvailability {
  // Connected, credentialed, bench-available, and NOT currently rate-limited.
  usable: number;
  // Connected, credentialed, bench-available, but throttled (rateLimitedUntil in
  // the future) — i.e. present but temporarily blocked by an external quota.
  rateLimited: number;
}

async function inspectGptCodeIntegrations(): Promise<GptCodeAvailability> {
  const now = new Date();
  const integrations = await local.integration.findMany({
    where: { name: 'gpt_code', status: 'CONNECTED' },
    select: {
      id: true,
      userId: true,
      poolingEnabled: true,
      config: true,
      rateLimitedUntil: true,
    },
  });

  const eligible = integrations.filter((integration) => {
    const isAvailableToBench =
      integration.userId === SEED_USER_ID || activeRemotePoolIntegrationIds.has(integration.id);
    return isAvailableToBench && hasEncryptedCredentials(integration.config);
  });

  let usable = 0;
  let rateLimited = 0;
  for (const integration of eligible) {
    if (integration.rateLimitedUntil !== null && integration.rateLimitedUntil > now) {
      rateLimited += 1;
    } else {
      usable += 1;
    }
  }
  return { usable, rateLimited };
}

interface ClaudeCodeAvailability {
  // Connected, credentialed, bench-available, and NOT currently rate-limited.
  usable: number;
  // Connected, credentialed, bench-available, but throttled (rateLimitedUntil in
  // the future) — present but temporarily blocked by an external quota.
  rateLimited: number;
}

async function inspectClaudeCodeIntegrations(): Promise<ClaudeCodeAvailability> {
  const now = new Date();
  const integrations = await local.integration.findMany({
    where: {
      name: 'claude_code',
      status: 'CONNECTED',
    },
    select: {
      id: true,
      userId: true,
      poolingEnabled: true,
      config: true,
      rateLimitedUntil: true,
    },
  });

  const eligible = integrations.filter((integration) => {
    const isAvailableToBench =
      integration.userId === SEED_USER_ID || activeRemotePoolIntegrationIds.has(integration.id);
    return isAvailableToBench && hasEncryptedCredentials(integration.config);
  });

  let usable = 0;
  let rateLimited = 0;
  for (const integration of eligible) {
    if (integration.rateLimitedUntil !== null && integration.rateLimitedUntil > now) {
      rateLimited += 1;
    } else {
      usable += 1;
    }
  }
  return { usable, rateLimited };
}

async function countUsableClaudeCodeIntegrations(): Promise<number> {
  return (await inspectClaudeCodeIntegrations()).usable;
}

async function syncComputeTokensWithRetries(): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= COMPUTE_TOKEN_SYNC_ATTEMPTS; attempt++) {
    try {
      const count = await syncIntegrations({ computeTokensOnly: true });
      await poolRequiredDevComputeTokensForSyntheticUsers();
      const { usable: usableClaudeCodeCount, rateLimited: rateLimitedClaudeCodeCount } =
        await inspectClaudeCodeIntegrations();
      const { usable: usableGptCodeCount, rateLimited: rateLimitedGptCodeCount } =
        await inspectGptCodeIntegrations();
      // Code-agent tasks accept Claude Code OR Codex (gpt_code). Fail only when
      // neither provider is usable (rate-limited rows still proceed — same as
      // the per-provider external-quota policy below).
      if (requireAnyComputeTokenType()) {
        if (usableClaudeCodeCount > 0 || usableGptCodeCount > 0) {
          console.log(
            `  ✅ Compute Tokens (integrations): ${count} synced, ` +
              `${usableClaudeCodeCount} usable claude_code, ${usableGptCodeCount} usable gpt_code ` +
              '(SEED_REQUIRE_COMPUTE_TOKEN_TYPES=any)'
          );
          return;
        }
        if (rateLimitedClaudeCodeCount > 0 || rateLimitedGptCodeCount > 0) {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, 0 usable code-agent tokens ` +
              `(claude_rate_limited=${rateLimitedClaudeCodeCount}, gpt_rate_limited=${rateLimitedGptCodeCount}) — ` +
              'proceeding under SEED_REQUIRE_COMPUTE_TOKEN_TYPES=any; runtime surfaces quota errors'
          );
          return;
        }
        throw new Error('No usable claude_code or gpt_code integrations after sync');
      }
      if (usableClaudeCodeCount === 0) {
        if (!COMPUTE_TOKEN_REQUIRED_TYPES.has('claude')) {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, ` +
              '0 usable claude_code — proceeding because this run requires GPT compute only ' +
              '(SEED_REQUIRE_COMPUTE_TOKEN_TYPES=gpt)'
          );
        } else if (rateLimitedClaudeCodeCount > 0) {
          // Mirror gpt_code: a claude_code row that EXISTS but is merely
          // rate-limited is an external-quota transient, not a missing
          // credential. Infra-fix deploys and non-Claude Code smoke must not
          // hard-fail the whole compute-token sync on Anthropic's cooldown;
          // Claude Code tasks still fail closed at their own credential gate.
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, 0 usable claude_code ` +
              `(${rateLimitedClaudeCodeCount} present but rate-limited by an external quota) — ` +
              `proceeding; callers that require Claude Code enforce that separately`
          );
        } else if (process.env.SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK === '1') {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, 0 usable claude_code — ` +
              `proceeding without Claude Code for a launcher-scoped non-Claude task ` +
              `(SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK=1)`
          );
        } else if (process.env.SEED_ALLOW_MISSING_CLAUDE_CODE === '1') {
          const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
          const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
          if (!anthropicApiKey && !openrouterApiKey) {
            throw new Error(
              'SEED_ALLOW_MISSING_CLAUDE_CODE=1 requires a non-empty ANTHROPIC_API_KEY or OPENROUTER_API_KEY'
            );
          }
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, ` +
              '0 usable claude_code — proceeding with the caller-validated ' +
              'Anthropic-compatible API fallback (SEED_ALLOW_MISSING_CLAUDE_CODE=1)'
          );
        } else {
          throw new Error('No usable claude_code integrations after sync');
        }
      }
      if (usableGptCodeCount === 0) {
        if (!COMPUTE_TOKEN_REQUIRED_TYPES.has('gpt')) {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, ` +
              `${usableClaudeCodeCount} usable claude_code, 0 usable gpt_code — ` +
              'proceeding because this run requires Claude compute only ' +
              '(SEED_REQUIRE_COMPUTE_TOKEN_TYPES=claude)'
          );
          return;
        }
        // A gpt_code (Codex) integration that EXISTS but is merely rate-limited
        // is an external-quota transient (e.g. the ChatGPT quota window), not a
        // misconfiguration. It must never hard-fail the compute-token sync: the
        // claude tokens every non-Codex run needs still synced, and a run that
        // actually uses Codex will surface the quota error at runtime. Only a
        // genuinely MISSING integration is a real setup problem — and even that
        // stays skippable via the explicit opt-out for known Codex-free runs.
        if (rateLimitedGptCodeCount > 0) {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, 0 usable gpt_code ` +
              `(${rateLimitedGptCodeCount} present but rate-limited by an external quota) — ` +
              `proceeding; claude tokens synced`
          );
          return;
        }
        // gpt_code (Codex) is only needed by runs that actually spawn a Codex
        // agent. When a caller knows the run doesn't use Codex — e.g. the
        // AgentCard browser payment-lifecycle gate — a missing Codex integration
        // must not block an otherwise-healthy compute-token sync.
        // Default (flag unset) stays strict so Codex regressions still surface.
        if (process.env.SEED_ALLOW_MISSING_GPT_CODE === '1') {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, ` +
              `${usableClaudeCodeCount} usable claude_code, 0 usable gpt_code — ` +
              `proceeding without Codex (SEED_ALLOW_MISSING_GPT_CODE=1; this run does not use Codex)`
          );
          return;
        }
        throw new Error('No usable gpt_code integrations after sync');
      }
      console.log(
        `  ✅ Compute Tokens (integrations): ${count} synced, ` +
          `${usableClaudeCodeCount} usable claude_code, ${usableGptCodeCount} usable gpt_code`
      );
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `  ❌ Compute Tokens (integrations): attempt ${attempt}/${COMPUTE_TOKEN_SYNC_ATTEMPTS} failed: ${message}`
      );
      if (attempt < COMPUTE_TOKEN_SYNC_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `Compute token sync failed after ${COMPUTE_TOKEN_SYNC_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function syncBrowserCredentials(failures?: Error[]): Promise<void> {
  // ── Browser Passwords ──
  await syncRequiredTable(
    'Browser Passwords',
    async () =>
      syncPagedCredentials(
        (page) => scopedRemoteBrowserAuth.browserPassword(page),
        (passwords) => syncBrowserPasswordCredentials(local.browserPassword, passwords),
        CREDENTIAL_PAGE_SIZE
      ),
    failures
  );

  await syncPasskeysOnly(failures);
}

async function syncPasskeysOnly(
  failures?: Error[],
  options: { authoritative?: boolean } = {}
): Promise<void> {
  // ── Passkey Credentials ──
  await syncRequiredTable(
    'Passkey Credentials',
    async () => {
      const passkeys = await scopedRemoteBrowserAuth.passkeyCredential();
      return syncPasskeyCredentialRows(local.passkeyCredential, passkeys);
    },
    failures
  );

  if (options.authoritative) {
    await syncRequiredTable(
      'Stale Local Passkeys',
      async () => {
        const remoteKeys = await remote.passkeyCredential.findMany({
          where: passkeySyncWhere(SEED_USER_ID, SEED_COOKIE_DOMAINS),
          select: { rpId: true, credentialId: true },
        });
        const liveKeys = new Set(
          remoteKeys.map(({ rpId, credentialId }) => `${rpId}\u0000${credentialId}`)
        );
        const localKeys = await local.passkeyCredential.findMany({
          where: passkeySyncWhere(SEED_USER_ID, SEED_COOKIE_DOMAINS),
          select: { id: true, rpId: true, credentialId: true },
        });
        const staleIds = localKeys
          .filter(({ rpId, credentialId }) => !liveKeys.has(`${rpId}\u0000${credentialId}`))
          .map(({ id }) => id);
        if (staleIds.length === 0) return 0;
        const deleted = await local.passkeyCredential.deleteMany({
          where: { id: { in: staleIds } },
        });
        return deleted.count;
      },
      failures
    );
  }
}

async function syncBrowserAuthForCurrentMode(failures?: Error[]): Promise<void> {
  if (SKIP_BROWSER_AUTH_SYNC) {
    console.log('  ⏭️  Browser auth state: skipped for simulated benchmark setup');
    return;
  }

  await syncBrowserState(failures);
  await syncBrowserCredentials(failures);
}

// Benchmark live fixtures shell out to `--credentials-only` while the isolated
// bench stack is under load (concurrent agents, cascade deletes of finished
// agent trees). A single transient local-DB failure (pool timeout, connection
// churn, upsert race) would otherwise fail the whole benchmark task before an
// agent even exists — observed 2026-07-18 (claude-code-agent smoke: one
// `localCookie.upsert()` invocation failed; the identical sync succeeded
// seconds later). Every sync step is an idempotent upsert, so bounded retries
// are safe. Mirrors syncComputeTokensWithRetries above.
// Retries now live per-table in syncRequiredCredentialTable, which re-runs ONLY
// the table that failed. Keeping a second multiplier here would restore the
// exact regression this replaced: a transient error on a late table re-read the
// whole graph (21k cookies + 3.1k bundles + 3.7k origins + a 38MB blob) up to
// three times and blew the bench live-fixture budget, so the task produced no
// verdict at all (descend antibot, browser-biometrics-webdecoy, 2026-07-27).
// One pass here; the bounded per-table budget absorbs transients.
const BROWSER_AUTH_SYNC_ATTEMPTS = 1;

async function syncBrowserAuthWithRetries(): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= BROWSER_AUTH_SYNC_ATTEMPTS; attempt++) {
    try {
      await syncBrowserAuthForCurrentMode();
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `  ❌ Browser auth sync: attempt ${attempt}/${BROWSER_AUTH_SYNC_ATTEMPTS} failed: ${message}`
      );
      if (attempt < BROWSER_AUTH_SYNC_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `Browser auth sync failed after ${BROWSER_AUTH_SYNC_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function throwBrowserAuthSyncFailures(failures: Error[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new Error(
    `Browser auth sync failed for ${failures.length} tables: ${failures
      .map((failure) => failure.message)
      .join('; ')}`
  );
}

/**
 * Guarantee the identity being seeded exists locally before any user-scoped row
 * is written.
 *
 * Every browser-auth table (PasskeyCredential, BrowserPassword, CookieBundle,
 * AgentIdentity, …) carries a userId FK. The full sync happens to create the
 * User first, but the scoped `--passkeys-only` / `--credentials-only` modes did
 * not, so they only ever worked by accident: the dev user was already present in
 * the base image. Any other SEED_LOCAL_USER_ID hit a FK violation — at seed time
 * for the passkey rows, or later at `POST /api/browser-session/init`.
 */
async function ensureSeedUserExists(): Promise<void> {
  await openLocalClient();
  const synced = await syncUserRecord(
    remote.user,
    local.user,
    SEED_USER_ID,
    COMPUTE_TOKENS_ONLY || PASSKEYS_ONLY || CREDENTIALS_ONLY || EMAIL_CREDENTIALS_ONLY
  );
  if (synced === 0) {
    throw new Error(
      `User ${SEED_USER_ID} not found in the remote database; cannot seed credentials for an identity that does not exist upstream`
    );
  }
  console.log(`  ✅ Identity ${SEED_USER_ID} present locally`);
}

async function sync() {
  console.log('🔄 Syncing from production database...');
  console.log(`   Remote: ${REMOTE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`   Local:  ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@') ?? 'default'}`);
  console.log(`   User:   ${SEED_USER_ID}\n`);

  // The first real read verifies connectivity and hydrates the selected user.
  // Keep initial pooler admission failures inside the existing retry owner.
  await syncRequiredCredentialTable('Seed identity', ensureSeedUserExists);

  if (COMPUTE_TOKENS_ONLY) {
    await syncComputeTokensWithRetries();
    console.log('\n🔄 Compute token sync complete.');
    return;
  }

  if (PASSKEYS_ONLY) {
    console.log(
      '  ℹ️  Syncing authoritative passkeys only; browser state and passwords are excluded'
    );
    await syncPasskeysOnly(undefined, { authoritative: true });
    console.log('\n🔄 Passkey sync complete.');
    return;
  }

  if (CREDENTIALS_ONLY) {
    console.log(
      SEED_COOKIE_DOMAINS.length > 0
        ? `  ℹ️  Refreshing production browser auth for ${SEED_COOKIE_DOMAINS.join(', ')} while preserving local-only rows`
        : '  ℹ️  Refreshing the complete production browser-auth graph while preserving local-only rows'
    );
    await syncBrowserAuthWithRetries();
    console.log('\n🔄 Credential sync complete.');
    return;
  }

  if (EMAIL_CREDENTIALS_ONLY) {
    let remoteToLocal = new Map<string, string>();
    await syncTable('Integrations', async () => {
      remoteToLocal = await syncEmailIntegrations();
      return remoteToLocal.size;
    });
    await syncTable('Email Credentials', async () => {
      const creds = await remote.emailIntegrationCredential.findMany({
        where: { userId: SEED_USER_ID },
        select: PROD_EMAIL_CREDENTIAL_COLUMNS,
      });
      return upsertById(
        local.emailIntegrationCredential,
        remapEmailCredentialIntegrationIds(creds, remoteToLocal)
      );
    });
    console.log('\n🔄 Email credential sync complete.');
    return;
  }

  // ── Global: Tools ──
  await syncTable('Tools', async () => {
    const tools = await remote.tool.findMany();
    for (const t of tools) {
      await local.tool.upsert({
        where: { name: t.name },
        create: { id: t.id, name: t.name, description: t.description, createdAt: t.createdAt },
        update: { description: t.description },
      });
    }
    return tools.length;
  });

  // ── User ──
  await syncTable('User', async () => {
    const count = await syncUserRecord(remote.user, local.user, SEED_USER_ID);
    if (count === 0) throw new Error(`User ${SEED_USER_ID} not found in remote`);
    return count;
  });

  // ── Credits ──
  await syncTable('Credits', async () => {
    const credits = await remote.credit.findMany({ where: { userId: SEED_USER_ID } });
    return upsertById(local.credit, credits);
  });

  // ── Subscription ──
  await syncTable('Subscription', async () => {
    const sub = await findProdSubscription(SEED_USER_ID);
    if (!sub) return 0;
    const { id, ...rest } = sub;
    await local.subscription.upsert({
      where: { userId: SEED_USER_ID },
      create: sub,
      update: rest,
    });
    return 1;
  });

  // ── Integrations ──
  await syncTable('Integrations', syncIntegrations);

  // ── Email Integration Credentials ──
  await syncTable('Email Credentials', async () => {
    const creds = await remote.emailIntegrationCredential.findMany({
      where: { userId: SEED_USER_ID },
      select: PROD_EMAIL_CREDENTIAL_COLUMNS,
    });
    const remoteToLocal = await emailIntegrationIdMap();
    return upsertById(
      local.emailIntegrationCredential,
      remapEmailCredentialIntegrationIds(creds, remoteToLocal)
    );
  });

  // ── People (contacts) ──
  await syncTable('People', async () => {
    // Paged for the same reason as Message Records: bound peak heap by page
    // size, not by contact count. A 2k-contact user is normal here.
    let peopleSynced = 0;
    for (let skip = 0; ; skip += PERSON_PAGE_SIZE) {
      const page = await remote.person.findMany({
        where: { userId: SEED_USER_ID },
        orderBy: { id: 'asc' },
        skip,
        take: PERSON_PAGE_SIZE,
      });
      if (page.length === 0) break;
      peopleSynced += await upsertById(local.person, page);
      sampleRss('People');
      if (page.length < PERSON_PAGE_SIZE) break;
    }
    return peopleSynced;
  });

  // ── Message Records ──
  await syncTable('Message Records', async () => {
    const personIds = (
      await remote.person.findMany({
        where: { userId: SEED_USER_ID },
        select: { id: true },
      })
    ).map((p) => p.id);
    if (personIds.length === 0) return 0;

    // Cap at the latest 10k messages across all contacts to keep seed fast and
    // local DB lean; older history isn't needed for dev/testing. A fixture that
    // must hold a user's whole history raises SEED_MESSAGE_LIMIT; peak heap stays
    // bounded by the page size either way.
    //
    // PAGED, not materialised. `findMany({ take: 10_000 })` held every row AND
    // its message body in one array before the first write; on a 4GB fleet
    // primary shared with Postgres + a 12-process worker pool that was the
    // SIGKILL (rc=137) which dropped a box from the 2026-07-29 fleet run before
    // its start barrier. Peak heap is now bounded by PAGE x row size, not by the
    // whole table. Enforced by src/tests/unit/seed-memory-ratchet.test.ts.
    const MESSAGE_LIMIT = positivePageSize('SEED_MESSAGE_LIMIT', 10_000);
    let messagesSynced = 0;
    for (let skip = 0; skip < MESSAGE_LIMIT; skip += MESSAGE_PAGE_SIZE) {
      const page = await remote.messageRecord.findMany({
        where: { personId: { in: personIds } },
        // id breaks timestamp ties so offset pages never repeat or skip a row.
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        skip,
        take: Math.min(MESSAGE_PAGE_SIZE, MESSAGE_LIMIT - skip),
        // Production may still be on the previous schema during a deploy.
        // Selecting only the shared columns lets the seed run before the
        // googleAccountEmail migration has been applied there.
        select: {
          id: true,
          personId: true,
          channel: true,
          from: true,
          to: true,
          timestamp: true,
          message: true,
          externalId: true,
          createdAt: true,
        },
      });
      if (page.length === 0) break;
      // The local benchmark DB runs beside the entire agent stack. Launching 500
      // Prisma upserts at once repeatedly killed Postgres on 4GB Fly primaries,
      // leaving every seed retry to fail with P1001. Stay below the configured
      // 50-connection pool.
      messagesSynced += await syncRowsWithConcurrency(
        page,
        25,
        (m) => {
          // Every synced person belongs to SEED_USER_ID, so it owns each message.
          const { id, ...rest } = m;
          return local.messageRecord.upsert({
            where: { id },
            create: { ...m, userId: SEED_USER_ID },
            update: { ...rest, userId: SEED_USER_ID },
          });
        },
        (completed) => {
          const done = messagesSynced + completed;
          if (done < MESSAGE_LIMIT) process.stdout.write(`     ${done}/${MESSAGE_LIMIT}...\r`);
        }
      );
      sampleRss('Message Records');
      if (page.length < MESSAGE_PAGE_SIZE) break;
    }
    return messagesSynced;
  });

  // ── Rose API Keys ──
  await syncTable('Rose API Keys', async () => {
    const keys = await remote.roseApiKey.findMany({ where: { userId: SEED_USER_ID } });
    return upsertById(local.roseApiKey, keys);
  });

  // ── Complete browser auth graph + credentials ──
  const browserAuthSyncFailures: Error[] = [];
  await syncBrowserAuthForCurrentMode(browserAuthSyncFailures);

  // ── Goal Blueprints ──
  await syncTable('Goal Blueprints', async () => {
    const blueprints = await remote.goalBlueprint.findMany({ where: { userId: SEED_USER_ID } });
    return upsertById(local.goalBlueprint, blueprints);
  });

  // ── GitHub Repo Access ──
  await syncTable('GitHub Repos', async () => {
    const repos = await remote.githubRepoAccess.findMany({ where: { userId: SEED_USER_ID } });
    return upsertById(local.githubRepoAccess, repos);
  });

  // ── SMS Session ──
  await syncTable('SMS Session', async () => {
    const session = await remote.smsSession.findUnique({ where: { userId: SEED_USER_ID } });
    if (!session) return 0;
    const { id, ...rest } = session;
    await local.smsSession.upsert({
      where: { userId: SEED_USER_ID },
      create: session as any,
      update: rest as any,
    });
    return 1;
  });

  // ── Feedback ──
  await syncTable('Feedback', async () => {
    const feedback = await remote.feedback.findMany({ where: { userId: SEED_USER_ID } });
    return upsertById(local.feedback, feedback);
  });

  // ── Waitlist (global, phone-bearing only) ──
  // Not user-scoped: these are the actionable signups the admin-health
  // "Waitlist People" panel lists + texts off the waitlist. Legacy email-only
  // rows are skipped (the panel filters them out anyway), so the local copy
  // stays tiny. The invite SMS only fires in production, so seeding real
  // numbers here is safe for local dev.
  await syncTable('Waitlist', async () => {
    // Explicit select (omits invitedAt): prod may not have that column yet the
    // first time this ships, and local invitedAt should start null anyway.
    const rawRows = await remote.waitlist.findMany({
      where: { phone: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        variant: true,
        referralCode: true,
        createdAt: true,
      },
    });
    // Drop empty-string phones: they can't be texted and would reach the admin
    // invite flow with a blank SMS destination.
    const rows = rawRows.filter((r) => (r.phone ?? '').trim() !== '');
    const synced = await upsertById(local.waitlist, rows);

    // Also pull the accounts these phones belong to, so the "Waitlist People"
    // panel renders truthful account/gate status locally instead of "No account
    // yet" for everyone. Minimal projection only — never copy sensitive columns
    // (e.g. encryptedPaymentInformation) or offWaitlistAt (may be absent in prod).
    const phones = rows.map((r) => r.phone).filter((p): p is string => p !== null);
    if (phones.length > 0) {
      await syncWaitlistAccounts(remote.user, local.user, phones);
    }
    return synced;
  });

  throwBrowserAuthSyncFailures(browserAuthSyncFailures);

  console.log('\n🔄 Sync complete.');
}

sync()
  .catch((err) => {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    // Report BEFORE disconnecting: the peak is what matters and the per-table
    // attribution is the whole point of the instrument. Defined but never
    // called on 2026-07-29, which is why the first real measurement (4983MB)
    // could not say which table produced it.
    writeRssReport();
    await remote.$disconnect();
    if (localOpened) await local.$disconnect();
  });
